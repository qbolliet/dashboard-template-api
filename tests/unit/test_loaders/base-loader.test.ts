/**
 * Unit tests for BaseQueryLoader and FactQueryLoader (src/loaders/base-loader.ts).
 *
 * Verifies constructor defaults, connection lifecycle in executeWithConnection,
 * table qualification logic, and cache key generation in loadWithCache.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import {
  makeLoaderConfig,
  makePool,
  makeExtendedConnection,
  makeDatabaseManager,
} from '../../helpers/mocks.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Instance d'un BaseQueryLoader — méthodes publiques testées. */
interface BaseQueryLoaderInstance {
  batchSize: number;
  cachePrefix: string;
  cacheEnabled: boolean;
  catalogId: string | null;
  schema: string | null;
  cacheTimeout: number;
  executeWithConnection: (fn: (conn: unknown) => Promise<unknown>) => Promise<unknown>;
  qualifyTable: (tableName: string) => string;
  loadWithCache: (key: unknown, loaderFn: () => Promise<unknown>) => Promise<unknown>;
}

/** Options de construction d'un BaseQueryLoader. */
interface BaseQueryLoaderOptions {
  batchSize?: number;
  cachePrefix?: string;
  cache?: boolean;
  catalogId?: string | null;
  schema?: string | null;
  cacheTimeout?: number;
}

/** Constructeur de BaseQueryLoader. */
interface BaseQueryLoaderConstructor {
  new (options?: BaseQueryLoaderOptions): BaseQueryLoaderInstance;
}

/** Instance d'un FactQueryLoader — méthodes de construction de clauses SQL. */
interface FactQueryLoaderInstance {
  buildSelectClause: (fields: string[] | null) => string;
  buildSortClause: (sort: Array<{ field: string; order: string }> | null) => string;
  validatePagination: (limit: number, offset: number) => void;
}

/** Constructeur de FactQueryLoader. */
interface FactQueryLoaderConstructor {
  new (): FactQueryLoaderInstance;
}

/** Module base-loader.ts après import dynamique. */
interface BaseLoaderModule {
  BaseQueryLoader: BaseQueryLoaderConstructor;
  FactQueryLoader: FactQueryLoaderConstructor;
}

// ─── État des mocks partagés ───────────────────────────────────────────────────

// Connexion et pool réutilisés dans tous les tests du fichier
const mockPool = makePool();
const mockConnection = makeExtendedConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

const mockWithCache = jest.fn();
const mockLogger = {
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));

jest.unstable_mockModule('../../../src/utils/cache.js', () => ({
  withCache: mockWithCache,
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: mockLogger,
}));

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Déclarations avant beforeAll — remplies après résolution des mocks
let BaseQueryLoader: BaseQueryLoaderConstructor;
let FactQueryLoader: FactQueryLoaderConstructor;

beforeAll(async () => {
  ({ BaseQueryLoader, FactQueryLoader } =
    (await import('../../../src/loaders/base-loader.js')) as unknown as BaseLoaderModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BaseQueryLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockDatabaseManager.getDefaultCatalog.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Constructeur ──────────────────────────────────────────────────────────

  describe('Constructor', () => {
    test('initialise avec la configuration par défaut', () => {
      const loader = new BaseQueryLoader();
      expect(loader.batchSize).toBe(5);
      expect(loader.cachePrefix).toBe('default');
      expect(loader.cacheEnabled).toBe(true);
      expect(loader.catalogId).toBeNull();
      expect(loader.cacheTimeout).toBe(300000);
    });

    test('initialise avec une configuration personnalisée', () => {
      const loader = new BaseQueryLoader({
        batchSize: 15,
        cachePrefix: 'custom',
        cache: false,
        catalogId: 'analytics',
        cacheTimeout: 99999,
      });
      expect(loader.batchSize).toBe(15);
      expect(loader.cachePrefix).toBe('custom');
      expect(loader.cacheEnabled).toBe(false);
      expect(loader.catalogId).toBe('analytics');
      expect(loader.cacheTimeout).toBe(99999);
    });

    test('cache activé par défaut même si non spécifié', () => {
      const loader = new BaseQueryLoader({ cache: undefined });
      expect(loader.cacheEnabled).toBe(true);
    });

    test('cache désactivé quand cache: false', () => {
      const loader = new BaseQueryLoader({ cache: false });
      expect(loader.cacheEnabled).toBe(false);
    });
  });

  // ── Gestion du cycle de vie des connexions ────────────────────────────────

  describe('executeWithConnection', () => {
    test('acquiert et libère la connexion correctement', async () => {
      const loader = new BaseQueryLoader({ catalogId: 'main' });
      const queryFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');

      const result = await loader.executeWithConnection(queryFn);

      expect(mockDatabaseManager.getPool).toHaveBeenCalledWith('main');
      expect(mockPool.acquire).toHaveBeenCalled();
      expect(queryFn).toHaveBeenCalledWith(mockConnection);
      expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
      expect(result).toBe('result');
    });

    test("libère la connexion même en cas d'erreur de la requête", async () => {
      const loader = new BaseQueryLoader();
      const queryFn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error('Query failed'));

      await expect(loader.executeWithConnection(queryFn)).rejects.toThrow('Query failed');
      expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
    });

    test("ne libère pas la connexion si l'acquisition échoue", async () => {
      const loader = new BaseQueryLoader();
      mockPool.acquire.mockRejectedValue(new Error('Pool exhausted'));
      const queryFn = jest.fn();

      await expect(loader.executeWithConnection(queryFn)).rejects.toThrow('Pool exhausted');
      expect(mockPool.release).not.toHaveBeenCalled();
      expect(queryFn).not.toHaveBeenCalled();
    });

    test('utilise null comme catalogId par défaut', async () => {
      const loader = new BaseQueryLoader({ catalogId: null });
      const queryFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');

      await loader.executeWithConnection(queryFn);
      expect(mockDatabaseManager.getPool).toHaveBeenCalledWith(null);
    });

    test('gère plusieurs opérations concurrentes', async () => {
      const loader = new BaseQueryLoader();
      const ops = Array.from({ length: 5 }, (_, i) =>
        loader.executeWithConnection(async () => `result-${i}`),
      );

      const results = await Promise.all(ops);
      expect(results).toHaveLength(5);
      expect(mockPool.acquire).toHaveBeenCalledTimes(5);
      expect(mockPool.release).toHaveBeenCalledTimes(5);
    });
  });

  // ── Qualification des noms de tables ──────────────────────────────────────

  describe('qualifyTable', () => {
    test('utilise catalogId quand il est défini', () => {
      const loader = new BaseQueryLoader({ catalogId: 'mydb' });
      mockDatabaseManager.getDefaultSchema.mockReturnValue('main');

      const result = loader.qualifyTable('fact_table');
      expect(result).toBe('"mydb".main.fact_table');
      expect(mockDatabaseManager.getDefaultSchema).toHaveBeenCalledWith('mydb');
    });

    test('utilise defaultDatabase quand catalogId est null', () => {
      const loader = new BaseQueryLoader({ catalogId: null });
      mockDatabaseManager.getDefaultCatalog.mockReturnValue('defaultdb');
      mockDatabaseManager.getDefaultSchema.mockReturnValue('main');

      const result = loader.qualifyTable('metadata');
      expect(result).toBe('"defaultdb".main.metadata');
    });

    test('formate correctement les noms de tables avec les guillemets', () => {
      const loader = new BaseQueryLoader({ catalogId: 'catalog1' });
      mockDatabaseManager.getDefaultSchema.mockReturnValue('myschema');

      const result = loader.qualifyTable('dim_country');
      expect(result).toBe('"catalog1".myschema.dim_country');
    });
  });

  // ── Chargement avec cache ─────────────────────────────────────────────────

  describe('loadWithCache', () => {
    test('appelle withCache quand le cache est activé', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'test', catalogId: 'main' });
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );

      const result = await loader.loadWithCache('mykey', loaderFn);

      expect(mockWithCache).toHaveBeenCalledWith(
        'test:main:_:"mykey"',
        loaderFn,
        loader.cacheTimeout,
      );
      expect(result).toBe('result');
    });

    test('contourne le cache quand désactivé', async () => {
      const loader = new BaseQueryLoader({ cache: false });
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('direct');

      const result = await loader.loadWithCache('key', loaderFn);

      expect(mockWithCache).not.toHaveBeenCalled();
      expect(loaderFn).toHaveBeenCalled();
      expect(result).toBe('direct');
    });

    test("fallback vers le chargement direct en cas d'erreur cache", async () => {
      const loader = new BaseQueryLoader({ cache: true });
      mockWithCache.mockRejectedValue(new Error('Cache error'));
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('fallback');

      const result = await loader.loadWithCache('key', loaderFn);

      expect(result).toBe('fallback');
      expect(loaderFn).toHaveBeenCalled();
    });

    test('génère la clé cache correcte pour un objet complexe', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'test', catalogId: 'main' });
      const complexKey = { field: 'value', nested: { prop: 123 } };
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );

      await loader.loadWithCache(complexKey, loaderFn);

      expect(mockWithCache).toHaveBeenCalledWith(
        `test:main:_:${JSON.stringify(complexKey)}`,
        loaderFn,
        loader.cacheTimeout,
      );
    });

    test('utilise "default" dans la clé cache quand catalogId est null', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'pre', catalogId: null });
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );

      await loader.loadWithCache('k', loaderFn);

      expect(mockWithCache).toHaveBeenCalledWith('pre:default:_:"k"', loaderFn, expect.any(Number));
    });

    test('fait le fallback si JSON.stringify échoue (référence circulaire)', async () => {
      const loader = new BaseQueryLoader({ cache: true });
      // Clé circulaire — JSON.stringify lève une erreur, fallback vers le chargeur direct
      const circularKey: Record<string, unknown> = {};
      circularKey['self'] = circularKey;
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');

      const result = await loader.loadWithCache(circularKey, loaderFn);
      expect(result).toBe('result');
      expect(loaderFn).toHaveBeenCalled();
    });
  });
});

// ─── FactQueryLoader ──────────────────────────────────────────────────────────

describe('FactQueryLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Construction de la clause SELECT ─────────────────────────────────────

  describe('buildSelectClause', () => {
    test('retourne * pour un tableau vide', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause([])).toBe('*');
    });

    test('retourne * pour null', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause(null)).toBe('*');
    });

    test('joint les champs par virgule', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause(['id', 'name', 'value'])).toBe('id, name, value');
    });

    test('gère un seul champ', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause(['id'])).toBe('id');
    });
  });

  // ── Construction de la clause ORDER BY ───────────────────────────────────

  describe('buildSortClause', () => {
    test('retourne une chaîne vide pour un tri vide', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSortClause([])).toBe('');
    });

    test('retourne une chaîne vide pour null', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSortClause(null)).toBe('');
    });

    test('construit la clause ORDER BY', () => {
      const loader = new FactQueryLoader();
      const result = loader.buildSortClause([
        { field: 'name', order: 'ASC' },
        { field: 'value', order: 'DESC' },
      ]);
      expect(result).toBe('ORDER BY name ASC, value DESC');
    });

    test('gère un seul critère de tri', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSortClause([{ field: 'id', order: 'ASC' }])).toBe('ORDER BY id ASC');
    });
  });

  // ── Validation de la pagination ───────────────────────────────────────────

  describe('validatePagination', () => {
    test('lève une erreur si limit dépasse MAX_LIMIT', () => {
      const loader = new FactQueryLoader();
      expect(() => loader.validatePagination(1001, 0)).toThrow('Limit cannot exceed 1000');
    });

    test('lève une erreur si offset dépasse MAX_OFFSET', () => {
      const loader = new FactQueryLoader();
      expect(() => loader.validatePagination(10, 10001)).toThrow('Offset cannot exceed 10000');
    });

    test("ne lève pas d'erreur pour une pagination valide", () => {
      const loader = new FactQueryLoader();
      expect(() => loader.validatePagination(100, 1000)).not.toThrow();
    });

    test("ne lève pas d'erreur aux valeurs limites exactes", () => {
      const loader = new FactQueryLoader();
      expect(() => loader.validatePagination(1000, 10000)).not.toThrow();
    });
  });
});
