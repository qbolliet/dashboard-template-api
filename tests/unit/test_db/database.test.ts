/**
 * Unit tests for DatabaseManager (src/db/database-manager.js).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader, logger, DuckDBPool, and the fs module.
 * Covers constructor initialization, getPool, isValidDatabase,
 * getAvailableDatabases, getDefaultDatabase, getSchema,
 * isCrossDatabaseAllowed, validateDatabaseRouting, getStatistics,
 * close, and concurrent operations.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration d'un catalogue DuckLake individuel. */
interface CatalogConfig {
  PATH: string;
  DATA_PATH: string;
  READ_ONLY: boolean;
  SCHEMAS?: string[] | string;
}

/** Configuration complète du module — reflète la structure de config-loader. */
interface MockConfig {
  CATALOG_ROUTING: {
    DEFAULT_CATALOG: string;
    ALLOWED_CATALOGS: string[];
    ALLOW_CROSS_CATALOG_QUERIES: boolean;
  };
  CATALOGS: Record<string, CatalogConfig>;
  DATABASE: {
    POOL: {
      MAX_CONNECTIONS: number;
      ACQUIRE_TIMEOUT: number;
      POOL_RETRY_DELAY: number;
    };
  };
  S3: { ENABLED: boolean };
}

/** Logger mocké — méthodes utilisées par le DatabaseManager. */
interface MockLogger {
  database: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  info: jest.Mock;
}

/** Pool mocké — simulation du DuckDBPool partagé. */
interface MockPool {
  pool: unknown[];
  maxConnections: number;
  catalogs: { alias: string }[];
  close: jest.Mock;
  acquire: jest.Mock;
  release: jest.Mock;
  reload: jest.Mock;
  reloadOne: jest.Mock;
  awaitDrain: jest.Mock;
  discoverCatalogSchemas: jest.Mock;
}

/** Configuration passée au constructeur DuckDBPool lors de l'initialisation. */
interface PoolConstructorConfig {
  maxConnections: number;
  acquireTimeout: number;
  catalogs: { alias: string; readOnly?: boolean; dataPath?: string }[];
  [key: string]: unknown;
}

/** Statistiques agrégées retournées par getStatistics(). */
interface ManagerStatistics {
  defaultCatalog: string;
  allowedCatalogs: string[];
  allowCrossCatalog: boolean;
  sharedPool: SharedPoolStats | null;
}

/** Statistiques du pool partagé — sous-objet de ManagerStatistics. */
interface SharedPoolStats {
  available: number;
  using: number;
  total: number;
  maxConnections: number;
  attachedCatalogs: string[];
}

/** Module database-manager.js après import dynamique. */
interface DatabaseManagerModule {
  DatabaseManager: new (options?: unknown) => DatabaseManagerInstance;
}

/** Version des données servie pour un (catalogue, schéma). */
interface DataVersion {
  version: string;
  updatedAt: string | null;
}

/** Instance de DatabaseManager avec les membres accessibles dans les tests. */
interface DatabaseManagerInstance {
  defaultCatalog: string;
  allowedCatalogs: string[];
  allowCrossCatalog: boolean;
  sharedPool: MockPool | null;
  getPool: (catalogId?: string | null) => MockPool;
  isValidCatalog: (id: string | null) => boolean;
  getAvailableCatalogs: () => string[];
  getDefaultCatalog: () => string;
  getDefaultSchema: (catalogId: string) => string;
  getSchemas: (catalogId: string) => string[];
  isValidSchema: (catalogId: string, schema: string) => boolean;
  isCrossCatalogAllowed: () => boolean;
  validateCatalogRouting: (requested?: string | null, context?: string | null) => string;
  getStatistics: () => ManagerStatistics;
  reloadCatalogs: () => Promise<void>;
  reloadCatalog: (catalogId: string) => Promise<void>;
  initSchemas: () => Promise<void>;
  getDataVersion: (catalogId: string, schema: string) => string;
  getDataVersions: () => Record<string, Record<string, DataVersion>>;
  getCatalogEntries: () => { alias: string }[];
  close: () => Promise<void>;
}

// ─── État partagé des mocks ───────────────────────────────────────────────────

// Configuration mockée — partagée entre tous les tests via référence mutable
const mockConfig: MockConfig = {
  CATALOG_ROUTING: {
    DEFAULT_CATALOG: 'main',
    ALLOWED_CATALOGS: ['main', 'test', 'analytics'],
    ALLOW_CROSS_CATALOG_QUERIES: true,
  },
  CATALOGS: {
    // SCHEMAS explicite (allow-list stricte : intersection avec la découverte)
    main: {
      PATH: 'data/main.ducklake',
      DATA_PATH: 'data/main_data/',
      READ_ONLY: true,
      SCHEMAS: ['main', 'staging'],
    },
    // Pas de SCHEMAS : politique "adopter la découverte" en réconciliation
    test: { PATH: 'data/test.ducklake', DATA_PATH: 'data/test_data/', READ_ONLY: false },
    // Pas de SCHEMAS non plus
    analytics: {
      PATH: 'data/analytics.ducklake',
      DATA_PATH: 'data/analytics_data/',
      READ_ONLY: true,
    },
  },
  DATABASE: {
    POOL: { MAX_CONNECTIONS: 5, ACQUIRE_TIMEOUT: 5000, POOL_RETRY_DELAY: 50 },
  },
  S3: { ENABLED: false },
};

const mockLogger: MockLogger = {
  database: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

// Simulation des méthodes fs — vérification de l'existence des fichiers
const fsExists: jest.Mock = jest.fn().mockReturnValue(true);
const fsStat: jest.Mock = jest.fn().mockReturnValue({ size: 1024, mtime: new Date() });

/**
 * Create a mock DuckDBPool instance reflecting the given configuration.
 *
 * Args:
 *     cfg: Pool constructor configuration.
 *
 * Returns:
 *     A MockPool with jest mock methods.
 */
const makeMockPool = (cfg: PoolConstructorConfig = {} as PoolConstructorConfig): MockPool => {
  const aliases = (cfg.catalogs ?? []).map((c) => c.alias);
  // Par défaut, la découverte simule un seul schéma 'main' pour chaque catalogue
  // attaché — ce qui correspond au cas mono-schéma historique.
  const defaultDiscovery: Record<string, string[]> = Object.fromEntries(
    aliases.map((a) => [a, ['main']]),
  );
  return {
    pool: [],
    maxConnections: cfg.maxConnections ?? 5,
    catalogs: (cfg.catalogs ?? []) as { alias: string }[],
    close: jest.fn().mockResolvedValue(undefined),
    acquire: jest.fn().mockResolvedValue({}),
    release: jest.fn(),
    reload: jest.fn().mockResolvedValue(undefined),
    reloadOne: jest.fn().mockResolvedValue(undefined),
    awaitDrain: jest.fn().mockResolvedValue(undefined),
    discoverCatalogSchemas: jest.fn().mockResolvedValue(defaultDiscovery),
  };
};

// Constructeur DuckDBPool mocké — retourne un pool par appel
const MockDuckDBPool: jest.Mock = jest
  .fn()
  .mockImplementation((cfg: PoolConstructorConfig) => makeMockPool(cfg));

// ─── Enregistrement des mocks (avant tout import dynamique) ──────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({ config: mockConfig }));
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => mockLogger,
}));
jest.unstable_mockModule('../../../src/db/pool.js', () => ({ DuckDBPool: MockDuckDBPool }));
jest.unstable_mockModule('fs', () => ({
  default: { existsSync: fsExists, statSync: fsStat },
  existsSync: fsExists,
  statSync: fsStat,
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

let DatabaseManager: new (options?: unknown) => DatabaseManagerInstance;

beforeAll(async () => {
  ({ DatabaseManager } =
    (await import('../../../src/db/database-manager.js')) as unknown as DatabaseManagerModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DatabaseManager', () => {
  let manager: DatabaseManagerInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    MockDuckDBPool.mockImplementation((cfg: PoolConstructorConfig) => makeMockPool(cfg));
    fsExists.mockReturnValue(true);
    fsStat.mockReturnValue({ size: 1024, mtime: new Date() });
    manager = new DatabaseManager();
  });

  // ── Constructeur et initialisation ────────────────────────────────────────

  describe('Constructor and initialization', () => {
    test('reads defaultDatabase from config', () => {
      expect(manager.defaultCatalog).toBe('main');
    });

    test('reads allowedDatabases from config', () => {
      expect(manager.allowedCatalogs).toEqual(['main', 'test', 'analytics']);
    });

    test('reads allowCrossDatabase from config', () => {
      expect(manager.allowCrossCatalog).toBe(true);
    });

    test('creates a single shared DuckDBPool containing all catalog aliases', () => {
      expect(MockDuckDBPool).toHaveBeenCalledTimes(1);
      const [poolCfg] = MockDuckDBPool.mock.calls[0] as [PoolConstructorConfig];
      const aliases = poolCfg.catalogs.map((c) => c.alias);
      expect(aliases).toContain('main');
      expect(aliases).toContain('test');
      expect(aliases).toContain('analytics');
    });

    test('passes correct pool settings to DuckDBPool', () => {
      const [poolCfg] = MockDuckDBPool.mock.calls[0] as [PoolConstructorConfig];
      expect(poolCfg.maxConnections).toBe(5);
      expect(poolCfg.acquireTimeout).toBe(5000);
    });

    test('catalogs include readOnly and dataPath', () => {
      const [poolCfg] = MockDuckDBPool.mock.calls[0] as [PoolConstructorConfig];
      const main = poolCfg.catalogs.find((c) => c.alias === 'main');
      expect(main!.readOnly).toBe(true);
      // dataPath doit se terminer par un séparateur de répertoire
      expect(main!.dataPath).toMatch(/\/$/);
    });

    test('logs a warning when a catalog file is missing', () => {
      fsExists.mockReturnValue(false);
      new DatabaseManager();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('does not throw when catalog files are missing', () => {
      fsExists.mockReturnValue(false);
      expect(() => new DatabaseManager()).not.toThrow();
    });

    test('throws when default catalog is absent from CATALOGS', () => {
      const savedCatalogs = mockConfig.CATALOGS;
      mockConfig.CATALOGS = {
        other: { PATH: 'other.ducklake', DATA_PATH: 'other_data/', READ_ONLY: true },
      };
      try {
        expect(() => new DatabaseManager()).toThrow(
          "Default catalog 'main' not found in CATALOGS config",
        );
      } finally {
        mockConfig.CATALOGS = savedCatalogs;
      }
    });

    test('error lists available catalogs when default is absent', () => {
      const savedCatalogs = mockConfig.CATALOGS;
      mockConfig.CATALOGS = {
        other: { PATH: 'other.ducklake', DATA_PATH: 'other_data/', READ_ONLY: true },
      };
      try {
        expect(() => new DatabaseManager()).toThrow('Available: other');
      } finally {
        mockConfig.CATALOGS = savedCatalogs;
      }
    });
  });

  // ── Récupération du pool ──────────────────────────────────────────────────

  describe('getPool', () => {
    test('returns the shared pool when no catalogId is specified', () => {
      expect(manager.getPool()).toBe(manager.sharedPool);
    });

    test('returns the same shared pool for any valid catalogId', () => {
      expect(manager.getPool('main')).toBe(manager.sharedPool);
      expect(manager.getPool('test')).toBe(manager.sharedPool);
      expect(manager.getPool('analytics')).toBe(manager.sharedPool);
    });

    test('null catalogId falls back to default', () => {
      expect(manager.getPool(null)).toBe(manager.sharedPool);
    });

    test('throws for an unknown catalogId', () => {
      expect(() => manager.getPool('nonexistent')).toThrow(
        "Catalog 'nonexistent' is not allowed or not configured",
      );
    });
  });

  // ── Validation de base de données ─────────────────────────────────────────

  describe('isValidDatabase', () => {
    test('returns true for each configured catalog', () => {
      expect(manager.isValidCatalog('main')).toBe(true);
      expect(manager.isValidCatalog('test')).toBe(true);
      expect(manager.isValidCatalog('analytics')).toBe(true);
    });

    test('returns false for unknown catalog', () => {
      expect(manager.isValidCatalog('unknown')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(manager.isValidCatalog('')).toBe(false);
    });

    test('returns false for null', () => {
      expect(manager.isValidCatalog(null)).toBe(false);
    });
  });

  // ── Liste des bases disponibles ───────────────────────────────────────────

  describe('getAvailableDatabases', () => {
    test('returns all allowed catalog IDs', () => {
      expect(manager.getAvailableCatalogs()).toEqual(['main', 'test', 'analytics']);
    });

    test('returns a copy — mutations do not affect internal state', () => {
      const dbs = manager.getAvailableCatalogs();
      dbs.push('extra');
      expect(manager.getAvailableCatalogs()).not.toContain('extra');
    });
  });

  // ── Base de données par défaut ────────────────────────────────────────────

  describe('getDefaultDatabase', () => {
    test('returns the configured default catalog', () => {
      expect(manager.getDefaultCatalog()).toBe('main');
    });
  });

  // ── Schémas d'un catalogue (multi-schema) ─────────────────────────────────

  describe('getDefaultSchema', () => {
    test('returns the first SCHEMAS entry for a configured catalog', () => {
      // main est configuré avec ['main', 'staging'] → défaut = 'main'
      expect(manager.getDefaultSchema('main')).toBe('main');
    });

    test('returns "main" when SCHEMAS is absent', () => {
      // test n'a pas de SCHEMAS → fallback ['main']
      expect(manager.getDefaultSchema('test')).toBe('main');
    });

    test('falls back to default catalog list for an unknown catalog', () => {
      expect(manager.getDefaultSchema('unknown')).toBe('main');
    });
  });

  describe('getSchemas', () => {
    test('returns the configured list when SCHEMAS is provided', () => {
      expect(manager.getSchemas('main')).toEqual(['main', 'staging']);
    });

    test('returns ["main"] when SCHEMAS is absent', () => {
      expect(manager.getSchemas('test')).toEqual(['main']);
    });

    test('returns a copy — mutations do not affect internal state', () => {
      const schemas = manager.getSchemas('main');
      schemas.push('extra');
      expect(manager.getSchemas('main')).not.toContain('extra');
    });
  });

  describe('isValidSchema', () => {
    test('returns true for each schema in the configured list', () => {
      expect(manager.isValidSchema('main', 'main')).toBe(true);
      expect(manager.isValidSchema('main', 'staging')).toBe(true);
    });

    test('returns false for a schema absent from the list', () => {
      expect(manager.isValidSchema('main', 'ghost')).toBe(false);
    });

    test('returns false for any schema on an unknown catalog', () => {
      expect(manager.isValidSchema('unknown', 'main')).toBe(false);
    });
  });

  // ── Réconciliation des schémas (config ↔ découverte SQL) ──────────────────

  describe('initSchemas', () => {
    test('keeps the configured intersection when SCHEMAS is explicit', async () => {
      const pool = manager.sharedPool!;
      pool.discoverCatalogSchemas.mockResolvedValueOnce({
        main: ['main', 'staging', 'extra'], // 'extra' n'est pas dans la config
        test: ['main'],
        analytics: ['main'],
      });

      await manager.initSchemas();

      // main reste restreint à la config (allow-list stricte) — pas d''extra'
      expect(manager.getSchemas('main')).toEqual(['main', 'staging']);
    });

    test('adopts the discovered list when SCHEMAS was not configured', async () => {
      const pool = manager.sharedPool!;
      pool.discoverCatalogSchemas.mockResolvedValueOnce({
        main: ['main', 'staging'],
        test: ['main', 'sandbox'], // test n'avait pas de SCHEMAS configuré
        analytics: ['main'],
      });

      await manager.initSchemas();

      // test adopte tout ce qui est découvert
      expect(manager.getSchemas('test')).toEqual(['main', 'sandbox']);
    });

    test('warns when a configured schema is missing from the discovery', async () => {
      const pool = manager.sharedPool!;
      pool.discoverCatalogSchemas.mockResolvedValueOnce({
        main: ['main'], // 'staging' configuré mais absent → warn
        test: ['main'],
        analytics: ['main'],
      });

      await manager.initSchemas();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Configured schemas missing'),
        expect.objectContaining({ missing: ['staging'] }),
      );
      expect(manager.getSchemas('main')).toEqual(['main']);
    });

    test('falls back to ["main"] when discovery returns nothing for a non-configured catalog', async () => {
      const pool = manager.sharedPool!;
      pool.discoverCatalogSchemas.mockResolvedValueOnce({
        main: ['main', 'staging'],
        test: [], // découverte vide pour test (non configuré)
        analytics: ['main'],
      });

      await manager.initSchemas();

      expect(manager.getSchemas('test')).toEqual(['main']);
    });

    test('keeps the configured list when the intersection would be empty', async () => {
      const pool = manager.sharedPool!;
      pool.discoverCatalogSchemas.mockResolvedValueOnce({
        main: ['totally_other'], // aucune intersection avec ['main','staging']
        test: ['main'],
        analytics: ['main'],
      });

      await manager.initSchemas();

      // Sécurité : on ne tue jamais l'allow-list, on logge un warn fort
      expect(manager.getSchemas('main')).toEqual(['main', 'staging']);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No configured schema was discovered'),
        expect.any(Object),
      );
    });

    test('rejects when shared pool is not initialized', async () => {
      manager.sharedPool = null;
      await expect(manager.initSchemas()).rejects.toThrow('Shared pool is not initialized');
    });

    test('reloadCatalogs reconciles schemas after the pool reload', async () => {
      const pool = manager.sharedPool!;
      pool.discoverCatalogSchemas.mockResolvedValueOnce({
        main: ['main', 'staging'],
        test: ['main', 'new_schema'],
        analytics: ['main'],
      });

      await manager.reloadCatalogs();

      expect(pool.reload).toHaveBeenCalledTimes(1);
      expect(pool.discoverCatalogSchemas).toHaveBeenCalledTimes(1);
      expect(manager.getSchemas('test')).toEqual(['main', 'new_schema']);
    });

    test('reloadCatalog reconciles schemas after a single-catalog reattach', async () => {
      const pool = manager.sharedPool!;
      pool.discoverCatalogSchemas.mockResolvedValueOnce({
        main: ['main', 'staging'],
        test: ['main', 'new_schema'],
        analytics: ['main'],
      });

      await manager.reloadCatalog('test');

      expect(pool.reloadOne).toHaveBeenCalledWith('test');
      expect(pool.discoverCatalogSchemas).toHaveBeenCalledTimes(1);
      expect(manager.getSchemas('test')).toEqual(['main', 'new_schema']);
    });
  });

  // ── Requêtes cross-database ───────────────────────────────────────────────

  describe('isCrossDatabaseAllowed', () => {
    test('returns the configured ALLOW_CROSS_DATABASE_QUERIES value', () => {
      expect(manager.isCrossCatalogAllowed()).toBe(true);
    });
  });

  // ── Routage des requêtes ──────────────────────────────────────────────────

  describe('validateDatabaseRouting', () => {
    test('returns requested catalog when valid', () => {
      expect(manager.validateCatalogRouting('test')).toBe('test');
    });

    test('falls back to context catalog when no explicit request', () => {
      expect(manager.validateCatalogRouting(null, 'analytics')).toBe('analytics');
    });

    test('falls back to default when neither is specified', () => {
      expect(manager.validateCatalogRouting()).toBe('main');
    });

    test('explicit request takes priority over context', () => {
      expect(manager.validateCatalogRouting('test', 'analytics')).toBe('test');
    });

    test('throws for an invalid catalog', () => {
      expect(() => manager.validateCatalogRouting('invalid')).toThrow(
        "Catalog 'invalid' is not available",
      );
    });

    test('error message lists available databases', () => {
      expect(() => manager.validateCatalogRouting('invalid')).toThrow(
        'Available catalogs: main, test, analytics',
      );
    });
  });

  // ── Statistiques ──────────────────────────────────────────────────────────

  describe('getStatistics', () => {
    test('returns routing configuration fields', () => {
      const stats = manager.getStatistics();
      expect(stats.defaultCatalog).toBe('main');
      expect(stats.allowedCatalogs).toEqual(['main', 'test', 'analytics']);
      expect(stats.allowCrossCatalog).toBe(true);
    });

    test('returns pool stats with attachedCatalogs', () => {
      const { sharedPool } = manager.getStatistics();
      expect(sharedPool).toBeDefined();
      expect(sharedPool!.attachedCatalogs).toEqual(
        expect.arrayContaining(['main', 'test', 'analytics']),
      );
    });

    test('sharedPool stats include available/using/total/maxConnections', () => {
      const { sharedPool } = manager.getStatistics();
      expect(sharedPool).toHaveProperty('available');
      expect(sharedPool).toHaveProperty('using');
      expect(sharedPool).toHaveProperty('total');
      expect(sharedPool).toHaveProperty('maxConnections');
    });

    test('returns null sharedPool when pool is not initialized', () => {
      manager.sharedPool = null;
      expect(manager.getStatistics().sharedPool).toBeNull();
    });
  });

  // ── Fermeture ─────────────────────────────────────────────────────────────

  describe('close', () => {
    test('delegates to pool.close()', async () => {
      const pool = manager.sharedPool!;
      await manager.close();
      expect(pool.close).toHaveBeenCalledTimes(1);
    });

    test('sets sharedPool to null after closing', async () => {
      await manager.close();
      expect(manager.sharedPool).toBeNull();
    });

    test('propagates pool close errors', async () => {
      manager.sharedPool!.close.mockRejectedValueOnce(new Error('Pool close failed'));
      await expect(manager.close()).rejects.toThrow('Pool close failed');
    });

    test('resolves without error when sharedPool is already null', async () => {
      manager.sharedPool = null;
      await expect(manager.close()).resolves.toBeUndefined();
    });
  });

  // ── Rechargement des catalogues ───────────────────────────────────────────

  describe('reloadCatalogs', () => {
    test('delegates to pool.reload()', async () => {
      const pool = manager.sharedPool!;
      await manager.reloadCatalogs();
      expect(pool.reload).toHaveBeenCalledTimes(1);
    });

    test('does not null the shared pool (unlike close)', async () => {
      await manager.reloadCatalogs();
      expect(manager.sharedPool).not.toBeNull();
    });

    test('propagates pool reload errors', async () => {
      manager.sharedPool!.reload.mockRejectedValueOnce(new Error('S3 unreachable'));
      await expect(manager.reloadCatalogs()).rejects.toThrow('S3 unreachable');
    });

    test('throws when the shared pool is not initialized', async () => {
      manager.sharedPool = null;
      await expect(manager.reloadCatalogs()).rejects.toThrow('Shared pool is not initialized');
    });

    test('waits for the retired instance to drain before re-reading the versions', async () => {
      const pool = manager.sharedPool!;
      const order: string[] = [];
      pool.reload.mockImplementationOnce(async () => {
        order.push('reload');
      });
      pool.awaitDrain.mockImplementationOnce(async () => {
        order.push('drain');
      });
      pool.discoverCatalogSchemas.mockImplementationOnce(async () => {
        order.push('versions');
        return { main: ['main'], test: ['main'], analytics: ['main'] };
      });

      await manager.reloadCatalogs();

      // Montée de version seulement après la fermeture de l'ancienne instance
      expect(order).toEqual(['reload', 'drain', 'versions']);
    });
  });

  // ── Versions des données servies ──────────────────────────────────────────

  describe('data versions', () => {
    /**
     * Makes the pool connection answer the dataset_metadata probe per schema.
     *
     * Args:
     *     markers: "catalog.schema" → row returned (undefined = table missing).
     */
    const answerProbe = (markers: Record<string, Record<string, unknown> | undefined>): void => {
      const all = jest.fn(async (sql: string) => {
        const match = /FROM "([^"]+)"\."([^"]+)"\."dataset_metadata"/.exec(sql);
        const key = match ? `${match[1]}.${match[2]}` : '';
        if (!(key in markers)) throw new Error('Catalog Error: table does not exist');
        return markers[key] ? [markers[key]] : [];
      });
      manager.sharedPool!.acquire.mockResolvedValue({ all });
    };

    test('reads schema_version and the updated_at marker in a single query', async () => {
      answerProbe({
        'main.main': {
          schema_version: 1,
          data_version: '1767225600123456',
          updated_at_iso: '2026-01-01T00:00:00.123456Z',
        },
      });

      await manager.initSchemas();

      expect(manager.getDataVersion('main', 'main')).toBe('1767225600123456');
      expect(manager.getDataVersions()['main']['main']).toEqual({
        version: '1767225600123456',
        updatedAt: '2026-01-01T00:00:00.123456Z',
      });
    });

    test('a missing table or a NULL updated_at is served as "none"', async () => {
      answerProbe({
        'main.main': { schema_version: 1, data_version: null, updated_at_iso: null },
      });

      await manager.initSchemas();

      expect(manager.getDataVersion('main', 'main')).toBe('none');
      // Table absente (lecture en erreur)
      expect(manager.getDataVersion('test', 'main')).toBe('none');
      // Schéma jamais lu
      expect(manager.getDataVersion('main', 'unknown')).toBe('none');
    });

    test('a reload replaces the served versions', async () => {
      answerProbe({ 'main.main': { schema_version: 1, data_version: '1' } });
      await manager.initSchemas();
      expect(manager.getDataVersion('main', 'main')).toBe('1');

      answerProbe({ 'main.main': { schema_version: 1, data_version: '2' } });
      await manager.reloadCatalogs();
      expect(manager.getDataVersion('main', 'main')).toBe('2');
    });
  });

  // ── Réglages explicites (plusieurs instances dans un processus) ───────────

  describe('explicit options', () => {
    test('uses the given catalogs instead of the configuration', () => {
      MockDuckDBPool.mockClear();
      const custom = new DatabaseManager({
        catalogs: [{ alias: 'lake', type: 'file', path: 'sqlite:/tmp/x.sqlite', readOnly: true }],
        schemas: { lake: ['s1', 's2'] },
      });

      expect(custom.getDefaultCatalog()).toBe('lake');
      expect(custom.getAvailableCatalogs()).toEqual(['lake']);
      expect(custom.getSchemas('lake')).toEqual(['s1', 's2']);
      const [poolCfg] = MockDuckDBPool.mock.calls[0] as [PoolConstructorConfig];
      // Chemin transmis tel quel (aucune résolution de chemin local)
      expect(poolCfg.catalogs).toEqual([
        { alias: 'lake', type: 'file', path: 'sqlite:/tmp/x.sqlite', readOnly: true },
      ]);
      expect(custom.getCatalogEntries().map((c) => c.alias)).toEqual(['lake']);
    });
  });
});

// ── Opérations concurrentes ───────────────────────────────────────────────────

describe('DatabaseManager — concurrent operations', () => {
  let manager: DatabaseManagerInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    MockDuckDBPool.mockImplementation((cfg: PoolConstructorConfig) => makeMockPool(cfg));
    fsExists.mockReturnValue(true);
    fsStat.mockReturnValue({ size: 1024, mtime: new Date() });
    manager = new DatabaseManager();
  });

  test('concurrent getPool calls all return the same shared pool', async () => {
    const results = await Promise.all([
      Promise.resolve(manager.getPool('main')),
      Promise.resolve(manager.getPool('test')),
      Promise.resolve(manager.getPool('analytics')),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  test('concurrent validateDatabaseRouting calls all succeed', async () => {
    const results = await Promise.all(
      ['main', 'test', 'analytics'].map((db) =>
        Promise.resolve(manager.validateCatalogRouting(db)),
      ),
    );
    expect(results).toEqual(['main', 'test', 'analytics']);
  });

  test('mix of operations runs without interference', async () => {
    const results = await Promise.all([
      Promise.resolve(manager.getPool('main')),
      Promise.resolve(manager.getStatistics()),
      Promise.resolve(manager.isValidCatalog('test')),
      Promise.resolve(manager.validateCatalogRouting('analytics')),
    ]);
    expect(results).toHaveLength(4);
    results.forEach((r) => expect(r).toBeDefined());
  });
});
