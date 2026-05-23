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
  SCHEMA?: string;
}

/** Configuration complète du module — reflète la structure de config-loader. */
interface MockConfig {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: string;
    ALLOWED_DATABASES: string[];
    ALLOW_CROSS_DATABASE_QUERIES: boolean;
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
  defaultDatabase: string;
  allowedDatabases: string[];
  allowCrossDatabase: boolean;
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
  DatabaseManager: new () => DatabaseManagerInstance;
}

/** Instance de DatabaseManager avec les membres accessibles dans les tests. */
interface DatabaseManagerInstance {
  defaultDatabase: string;
  allowedDatabases: string[];
  allowCrossDatabase: boolean;
  sharedPool: MockPool | null;
  getPool: (catalogId?: string | null) => MockPool;
  isValidDatabase: (id: string | null) => boolean;
  getAvailableDatabases: () => string[];
  getDefaultDatabase: () => string;
  getSchema: (catalogId: string) => string;
  isCrossDatabaseAllowed: () => boolean;
  validateDatabaseRouting: (requested?: string | null, context?: string | null) => string;
  getStatistics: () => ManagerStatistics;
  reloadCatalogs: () => Promise<void>;
  close: () => Promise<void>;
}

// ─── État partagé des mocks ───────────────────────────────────────────────────

// Configuration mockée — partagée entre tous les tests via référence mutable
const mockConfig: MockConfig = {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: 'main',
    ALLOWED_DATABASES: ['main', 'test', 'analytics'],
    ALLOW_CROSS_DATABASE_QUERIES: true,
  },
  CATALOGS: {
    main: { PATH: 'data/main.ducklake', DATA_PATH: 'data/main_data/', READ_ONLY: true },
    test: { PATH: 'data/test.ducklake', DATA_PATH: 'data/test_data/', READ_ONLY: false },
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
const makeMockPool = (cfg: PoolConstructorConfig = {} as PoolConstructorConfig): MockPool => ({
  pool: [],
  maxConnections: cfg.maxConnections ?? 5,
  catalogs: (cfg.catalogs ?? []) as { alias: string }[],
  close: jest.fn().mockResolvedValue(undefined),
  acquire: jest.fn().mockResolvedValue({}),
  release: jest.fn(),
  reload: jest.fn().mockResolvedValue(undefined),
});

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

let DatabaseManager: new () => DatabaseManagerInstance;

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
      expect(manager.defaultDatabase).toBe('main');
    });

    test('reads allowedDatabases from config', () => {
      expect(manager.allowedDatabases).toEqual(['main', 'test', 'analytics']);
    });

    test('reads allowCrossDatabase from config', () => {
      expect(manager.allowCrossDatabase).toBe(true);
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
          "Default database 'main' not found in CATALOGS config",
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
        "Database 'nonexistent' is not allowed or not configured",
      );
    });
  });

  // ── Validation de base de données ─────────────────────────────────────────

  describe('isValidDatabase', () => {
    test('returns true for each configured catalog', () => {
      expect(manager.isValidDatabase('main')).toBe(true);
      expect(manager.isValidDatabase('test')).toBe(true);
      expect(manager.isValidDatabase('analytics')).toBe(true);
    });

    test('returns false for unknown catalog', () => {
      expect(manager.isValidDatabase('unknown')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(manager.isValidDatabase('')).toBe(false);
    });

    test('returns false for null', () => {
      expect(manager.isValidDatabase(null)).toBe(false);
    });
  });

  // ── Liste des bases disponibles ───────────────────────────────────────────

  describe('getAvailableDatabases', () => {
    test('returns all allowed catalog IDs', () => {
      expect(manager.getAvailableDatabases()).toEqual(['main', 'test', 'analytics']);
    });

    test('returns a copy — mutations do not affect internal state', () => {
      const dbs = manager.getAvailableDatabases();
      dbs.push('extra');
      expect(manager.getAvailableDatabases()).not.toContain('extra');
    });
  });

  // ── Base de données par défaut ────────────────────────────────────────────

  describe('getDefaultDatabase', () => {
    test('returns the configured default catalog', () => {
      expect(manager.getDefaultDatabase()).toBe('main');
    });
  });

  // ── Schéma d'un catalogue ─────────────────────────────────────────────────

  describe('getSchema', () => {
    test('returns "main" when no SCHEMA is configured for a catalog', () => {
      expect(manager.getSchema('main')).toBe('main');
    });

    test('returns default schema for an unknown catalogId', () => {
      expect(manager.getSchema('unknown')).toBe('main');
    });

    test('returns configured SCHEMA when present', () => {
      const savedCatalogs = mockConfig.CATALOGS;
      mockConfig.CATALOGS = {
        main: {
          PATH: 'main.ducklake',
          DATA_PATH: 'main_data/',
          READ_ONLY: true,
          SCHEMA: 'custom_schema',
        },
      };
      const m = new DatabaseManager();
      expect(m.getSchema('main')).toBe('custom_schema');
      mockConfig.CATALOGS = savedCatalogs;
    });
  });

  // ── Requêtes cross-database ───────────────────────────────────────────────

  describe('isCrossDatabaseAllowed', () => {
    test('returns the configured ALLOW_CROSS_DATABASE_QUERIES value', () => {
      expect(manager.isCrossDatabaseAllowed()).toBe(true);
    });
  });

  // ── Routage des requêtes ──────────────────────────────────────────────────

  describe('validateDatabaseRouting', () => {
    test('returns requested catalog when valid', () => {
      expect(manager.validateDatabaseRouting('test')).toBe('test');
    });

    test('falls back to context catalog when no explicit request', () => {
      expect(manager.validateDatabaseRouting(null, 'analytics')).toBe('analytics');
    });

    test('falls back to default when neither is specified', () => {
      expect(manager.validateDatabaseRouting()).toBe('main');
    });

    test('explicit request takes priority over context', () => {
      expect(manager.validateDatabaseRouting('test', 'analytics')).toBe('test');
    });

    test('throws for an invalid catalog', () => {
      expect(() => manager.validateDatabaseRouting('invalid')).toThrow(
        "Database 'invalid' is not available",
      );
    });

    test('error message lists available databases', () => {
      expect(() => manager.validateDatabaseRouting('invalid')).toThrow(
        'Available databases: main, test, analytics',
      );
    });
  });

  // ── Statistiques ──────────────────────────────────────────────────────────

  describe('getStatistics', () => {
    test('returns routing configuration fields', () => {
      const stats = manager.getStatistics();
      expect(stats.defaultDatabase).toBe('main');
      expect(stats.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(stats.allowCrossDatabase).toBe(true);
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
        Promise.resolve(manager.validateDatabaseRouting(db)),
      ),
    );
    expect(results).toEqual(['main', 'test', 'analytics']);
  });

  test('mix of operations runs without interference', async () => {
    const results = await Promise.all([
      Promise.resolve(manager.getPool('main')),
      Promise.resolve(manager.getStatistics()),
      Promise.resolve(manager.isValidDatabase('test')),
      Promise.resolve(manager.validateDatabaseRouting('analytics')),
    ]);
    expect(results).toHaveLength(4);
    results.forEach((r) => expect(r).toBeDefined());
  });
});
