/**
 * Unit tests for cache-invalidation.js (src/cache/cache-invalidation.js).
 *
 * Verifies CacheInvalidationManager key patterns (catalog × schema),
 * scan/delete operations, multi-catalog invalidation, nested cache stats
 * collection, and Express route registration via createCacheInvalidationRoutes
 * — including the new per-schema invalidation endpoint.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Client Redis mocké — méthodes utilisées par CacheInvalidationManager. */
interface MockRedis {
  scan: jest.Mock;
  del: jest.Mock;
}

/** Configuration de la stratégie de reconnexion Redis. */
interface RetryStrategyConfig {
  BASE_DELAY: number;
  MAX_DELAY: number;
}

/** Options de connexion Redis. */
interface RedisOptions {
  RETRY_STRATEGY: RetryStrategyConfig;
  MAX_RETRIES_PER_REQUEST: number;
  ENABLE_READY_CHECK: boolean;
  CONNECT_TIMEOUT: number;
}

/** Configuration du cluster Redis. */
interface ClusterConfig {
  ENABLED: boolean;
  NODES: unknown[];
}

/** Configuration Redis complète. */
interface RedisConfig {
  HOST: string;
  PORT: number;
  PASSWORD: null;
  KEY_PREFIX: string;
  OPTIONS: RedisOptions;
  CLUSTER: ClusterConfig;
}

/** Section cache de la configuration globale. */
interface CacheConfig {
  REDIS: RedisConfig;
}

/** Configuration globale mockée — reflète la structure YAML de config/. */
interface MockConfig {
  CACHE: CacheConfig;
}

/** Fonctions de génération de patterns de clés Redis par type de cache. */
interface KeyPatterns {
  metadata: (catalog?: string | null, schema?: string | null) => string;
  dimension: (catalog?: string | null, schema?: string | null) => string;
  dimensionValue: (catalog?: string | null, schema?: string | null) => string;
  facts: (catalog?: string | null, schema?: string | null) => string;
  aggregatedFacts: (catalog?: string | null, schema?: string | null) => string;
  selectOptions: (catalog?: string | null, schema?: string | null) => string;
  allCatalog: (catalog?: string | null, schema?: string | null) => string;
}

/** Instance du gestionnaire d'invalidation du cache. */
interface CacheInvalidationManagerInstance {
  keyPatterns: KeyPatterns;
  scanKeys: (pattern: string) => Promise<string[]>;
  invalidateCatalog: (catalog?: string | null, schema?: string | null) => Promise<void>;
  invalidateCacheType: (
    type: string,
    catalog?: string | null,
    schema?: string | null,
  ) => Promise<void>;
  invalidateAllCatalogs: () => Promise<void>;
  getCacheStats: () => Promise<Record<string, Record<string, Record<string, number>>>>;
}

/** Constructeur du gestionnaire d'invalidation du cache. */
interface CacheInvalidationManagerConstructor {
  new (): CacheInvalidationManagerInstance;
}

/** Module cache-invalidation.js après import dynamique. */
interface CacheInvalidationModule {
  CacheInvalidationManager: CacheInvalidationManagerConstructor;
  cacheInvalidationManager: CacheInvalidationManagerInstance;
  createCacheInvalidationRoutes: (app: MockApp) => void;
}

/** Application Express mockée — enregistrement des routes POST et GET. */
interface MockApp {
  post: jest.Mock;
  get: jest.Mock;
}

/** Réponse HTTP mockée — simulation de res.status().json(). */
interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
}

/** Requête HTTP mockée — simulation de req.headers et req.params. */
interface MockRequest {
  headers: Record<string, string>;
  params: Record<string, string>;
}

/** Subset de databaseManager utilisé par cache-invalidation. */
interface MockDatabaseManager {
  getAvailableCatalogs: jest.Mock;
  isValidCatalog: jest.Mock;
  isValidSchema: jest.Mock;
  getSchemas: jest.Mock;
}

// ─── État des mocks ───────────────────────────────────────────────────────────

// Objet Redis partagé — référence stable réutilisée par tous les tests
const mockRedis: MockRedis = {
  scan: jest.fn(),
  del: jest.fn(),
};

// Configuration mockée — reflète la structure YAML de config/
const mockConfig: MockConfig = {
  CACHE: {
    REDIS: {
      HOST: 'localhost',
      PORT: 6379,
      PASSWORD: null,
      KEY_PREFIX: 'test:',
      OPTIONS: {
        RETRY_STRATEGY: { BASE_DELAY: 50, MAX_DELAY: 2000 },
        MAX_RETRIES_PER_REQUEST: 3,
        ENABLE_READY_CHECK: true,
        CONNECT_TIMEOUT: 10000,
      },
      CLUSTER: { ENABLED: false, NODES: [] },
    },
  },
};

// Catalogues et schémas par défaut utilisés par les tests :
// main → [main, analytics] (multi-schémas), test → [main], analytics → [main]
const defaultCatalogs = ['main', 'test', 'analytics'];
const defaultSchemasByCatalog: Record<string, string[]> = {
  main: ['main', 'analytics'],
  test: ['main'],
  analytics: ['main'],
};

// Gestionnaire de base de données mocké — référence stable réutilisée par les tests
const mockDatabaseManager: MockDatabaseManager = {
  getAvailableCatalogs: jest.fn(() => [...defaultCatalogs]),
  isValidCatalog: jest.fn((catalog: string) => defaultCatalogs.includes(catalog)),
  isValidSchema: jest.fn((catalog: string, schema: string) =>
    (defaultSchemasByCatalog[catalog] ?? []).includes(schema),
  ),
  getSchemas: jest.fn((catalog: string) => [...(defaultSchemasByCatalog[catalog] ?? [])]),
};

// Réinitialise les implémentations par défaut après un jest.resetAllMocks()
const restoreDatabaseManagerMocks = (): void => {
  mockDatabaseManager.getAvailableCatalogs.mockImplementation(() => [...defaultCatalogs]);
  mockDatabaseManager.isValidCatalog.mockImplementation((catalog: string) =>
    defaultCatalogs.includes(catalog),
  );
  mockDatabaseManager.isValidSchema.mockImplementation((catalog: string, schema: string) =>
    (defaultSchemasByCatalog[catalog] ?? []).includes(schema),
  );
  mockDatabaseManager.getSchemas.mockImplementation((catalog: string) => [
    ...(defaultSchemasByCatalog[catalog] ?? []),
  ]);
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

// Substitution du module cache avant tout import dynamique
jest.unstable_mockModule('../../../src/cache/index.js', () => ({
  redis: mockRedis,
  createRedisClient: jest.fn(),
}));

// Substitution du chargeur de configuration
jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// Substitution du gestionnaire de base de données — source des catalogues/schémas
jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));

// Le middleware admin n'est pas exercé ici (les tests appellent les handlers
// directement), mais l'import doit résoudre pour que les routes s'enregistrent.
jest.unstable_mockModule('../../../src/security/admin-auth.js', () => ({
  requireAdminKey: jest.fn((_req: MockRequest, _res: MockResponse, next: jest.Mock) => next()),
}));

// Substitution du logger — silence des sorties console pendant les tests
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    cache: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Variables déclarées avant beforeAll — remplies après résolution des mocks
let CacheInvalidationManager: CacheInvalidationManagerConstructor;
let cacheInvalidationManager: CacheInvalidationManagerInstance;
let createCacheInvalidationRoutes: (app: MockApp) => void;

beforeAll(async () => {
  ({ CacheInvalidationManager, cacheInvalidationManager, createCacheInvalidationRoutes } =
    (await import('../../../src/cache/cache-invalidation.js')) as unknown as CacheInvalidationModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CacheInvalidationManager', () => {
  let manager: CacheInvalidationManagerInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    restoreDatabaseManagerMocks();
    manager = new CacheInvalidationManager();
  });

  // ── Constructeur ──────────────────────────────────────────────────────────

  describe('constructor', () => {
    test('exposes key-pattern functions for all cache types', () => {
      const expected: Array<keyof KeyPatterns> = [
        'metadata',
        'dimension',
        'dimensionValue',
        'facts',
        'aggregatedFacts',
        'selectOptions',
        'allCatalog',
      ];
      for (const type of expected) {
        expect(manager.keyPatterns[type]).toBeInstanceOf(Function);
      }
    });

    test('generates correct (catalog, schema) patterns when both are provided', () => {
      expect(manager.keyPatterns.metadata('main', 'main')).toBe('metadata:main:main:*');
      expect(manager.keyPatterns.dimension('test', 'analytics')).toBe('dimension:test:analytics:*');
      expect(manager.keyPatterns.dimensionValue('main', 'foo')).toBe('dimension-value:main:foo:*');
      expect(manager.keyPatterns.facts('analytics', 'main')).toBe('facts:analytics:main:*');
      expect(manager.keyPatterns.aggregatedFacts('main', 'main')).toBe(
        'aggregated-facts:main:main:*',
      );
      expect(manager.keyPatterns.selectOptions('main', 'main')).toBe('select-options:main:main:*');
      expect(manager.keyPatterns.allCatalog('main', 'main')).toBe('*:main:main:*');
    });

    test('omits schema → wildcard, matching every schema of the catalog', () => {
      expect(manager.keyPatterns.metadata('main')).toBe('metadata:main:*:*');
      expect(manager.keyPatterns.allCatalog('test')).toBe('*:test:*:*');
      expect(manager.keyPatterns.facts('analytics', null)).toBe('facts:analytics:*:*');
    });

    test('falls back to "default" catalog when catalog is falsy', () => {
      expect(manager.keyPatterns.facts()).toBe('facts:default:*:*');
      expect(manager.keyPatterns.metadata(null)).toBe('metadata:default:*:*');
      expect(manager.keyPatterns.metadata(undefined)).toBe('metadata:default:*:*');
      expect(manager.keyPatterns.metadata('')).toBe('metadata:default:*:*');
    });
  });

  // ── Parcours des clés Redis ───────────────────────────────────────────────

  describe('scanKeys', () => {
    test('returns keys from a single-page scan', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', ['key1', 'key2', 'key3']]);

      const keys = await manager.scanKeys('metadata:main:main:*');

      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'metadata:main:main:*',
        'COUNT',
        100,
      );
      expect(keys).toEqual(['key1', 'key2', 'key3']);
    });

    test('accumulates keys across multiple scan pages', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['42', ['key1', 'key2']])
        .mockResolvedValueOnce(['0', ['key3', 'key4']]);

      const keys = await manager.scanKeys('*:main:*:*');

      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
      expect(keys).toEqual(['key1', 'key2', 'key3', 'key4']);
    });

    test('returns empty array when no keys match', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      const keys = await manager.scanKeys('nonexistent:*');

      expect(keys).toEqual([]);
    });
  });

  // ── Invalidation par catalogue (et/ou schéma) ─────────────────────────────

  describe('invalidateCatalog', () => {
    test('without schema → wildcard matching every schema of the catalog', async () => {
      const keysToDelete = [
        'metadata:main:main:k1',
        'facts:main:main:k2',
        'facts:main:analytics:k3',
      ];
      mockRedis.scan.mockResolvedValueOnce(['0', keysToDelete]);
      mockRedis.del.mockResolvedValueOnce(3);

      await manager.invalidateCatalog('main');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', '*:main:*:*', 'COUNT', 100);
      expect(mockRedis.del).toHaveBeenCalledWith(...keysToDelete);
    });

    test('with schema → narrows the pattern to that single (catalog, schema)', async () => {
      const keysToDelete = ['metadata:main:analytics:k1', 'facts:main:analytics:k2'];
      mockRedis.scan.mockResolvedValueOnce(['0', keysToDelete]);
      mockRedis.del.mockResolvedValueOnce(2);

      await manager.invalidateCatalog('main', 'analytics');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', '*:main:analytics:*', 'COUNT', 100);
      expect(mockRedis.del).toHaveBeenCalledWith(...keysToDelete);
    });

    test('skips del when no keys are found', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateCatalog('empty');

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    test('uses "default" when called without argument', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateCatalog();

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', '*:default:*:*', 'COUNT', 100);
    });

    test('uses "default" when null is passed', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateCatalog(null);

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', '*:default:*:*', 'COUNT', 100);
    });

    test('propagates Redis scan errors', async () => {
      mockRedis.scan.mockRejectedValueOnce(new Error('Redis connection failed'));

      await expect(manager.invalidateCatalog('main')).rejects.toThrow('Redis connection failed');
    });
  });

  // ── Invalidation par type de cache ────────────────────────────────────────

  describe('invalidateCacheType', () => {
    test('deletes keys for the specified type, catalog and schema', async () => {
      const keys = ['metadata:main:main:field1', 'metadata:main:main:field2'];
      mockRedis.scan.mockResolvedValueOnce(['0', keys]);
      mockRedis.del.mockResolvedValueOnce(2);

      await manager.invalidateCacheType('metadata', 'main', 'main');

      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'metadata:main:main:*',
        'COUNT',
        100,
      );
      expect(mockRedis.del).toHaveBeenCalledWith(...keys);
    });

    test('omits schema → wildcard, matching every schema for that type', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateCacheType('facts', 'main');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'facts:main:*:*', 'COUNT', 100);
    });

    test('throws for an unknown cache type', async () => {
      await expect(manager.invalidateCacheType('unknown', 'main')).rejects.toThrow(
        'Unknown cache type: unknown',
      );
    });

    test('uses "default" when catalog is not specified', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateCacheType('facts');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'facts:default:*:*', 'COUNT', 100);
    });

    test('skips del when no matching keys exist', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateCacheType('dimension', 'test', 'main');

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    test('handles all supported cache types without error', async () => {
      const types = [
        'metadata',
        'dimension',
        'dimensionValue',
        'facts',
        'aggregatedFacts',
        'selectOptions',
      ];
      for (const type of types) {
        mockRedis.scan.mockResolvedValueOnce(['0', []]);
        await expect(manager.invalidateCacheType(type, 'main', 'main')).resolves.not.toThrow();
      }
    });

    test('propagates Redis errors', async () => {
      mockRedis.scan.mockRejectedValueOnce(new Error('Scan failed'));

      await expect(manager.invalidateCacheType('metadata', 'main')).rejects.toThrow('Scan failed');
    });
  });

  // ── Invalidation globale ──────────────────────────────────────────────────

  describe('invalidateAllCatalogs', () => {
    test('calls invalidateCatalog for every configured catalog', async () => {
      const spy = jest.spyOn(manager, 'invalidateCatalog').mockResolvedValue();

      await manager.invalidateAllCatalogs();

      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenCalledWith('main');
      expect(spy).toHaveBeenCalledWith('test');
      expect(spy).toHaveBeenCalledWith('analytics');
    });

    test('does not throw when individual catalogs fail', async () => {
      jest
        .spyOn(manager, 'invalidateCatalog')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('test catalog error'))
        .mockResolvedValueOnce(undefined);

      await expect(manager.invalidateAllCatalogs()).resolves.not.toThrow();
    });

    test('propagates error when databaseManager.getAvailableCatalogs throws', async () => {
      mockDatabaseManager.getAvailableCatalogs.mockImplementationOnce(() => {
        throw new Error('config unavailable');
      });

      await expect(manager.invalidateAllCatalogs()).rejects.toThrow('config unavailable');
    });
  });

  // ── Statistiques du cache ─────────────────────────────────────────────────

  describe('getCacheStats', () => {
    test('returns nested catalog → schema → type counts', async () => {
      // 3 catalogues : main a 2 schémas (main, analytics), les autres 1 (main)
      // Donc 4 (schema, catalog) combinaisons × 6 types = 24 appels scan
      // Ordre des schémas dans main : main puis analytics (cf. defaultSchemasByCatalog)
      // Ordre des types : metadata, dimension, dimensionValue, facts, aggregatedFacts, selectOptions
      const scanResults: [string, string[]][] = [
        // main / main : 2, 1, 0, 3, 0, 1
        ['0', ['m1', 'm2']],
        ['0', ['d1']],
        ['0', []],
        ['0', ['f1', 'f2', 'f3']],
        ['0', []],
        ['0', ['s1']],
        // main / analytics : 0, 0, 0, 4, 0, 0
        ['0', []],
        ['0', []],
        ['0', []],
        ['0', ['f10', 'f11', 'f12', 'f13']],
        ['0', []],
        ['0', []],
        // test / main : 1, 0, 0, 1, 0, 0
        ['0', ['m3']],
        ['0', []],
        ['0', []],
        ['0', ['f4']],
        ['0', []],
        ['0', []],
        // analytics / main : tout à 0
        ['0', []],
        ['0', []],
        ['0', []],
        ['0', []],
        ['0', []],
        ['0', []],
      ];
      for (const result of scanResults) {
        mockRedis.scan.mockResolvedValueOnce(result);
      }

      const stats = await manager.getCacheStats();

      expect(stats).toEqual({
        main: {
          main: {
            metadata: 2,
            dimension: 1,
            dimensionValue: 0,
            facts: 3,
            aggregatedFacts: 0,
            selectOptions: 1,
          },
          analytics: {
            metadata: 0,
            dimension: 0,
            dimensionValue: 0,
            facts: 4,
            aggregatedFacts: 0,
            selectOptions: 0,
          },
        },
        test: {
          main: {
            metadata: 1,
            dimension: 0,
            dimensionValue: 0,
            facts: 1,
            aggregatedFacts: 0,
            selectOptions: 0,
          },
        },
        analytics: {
          main: {
            metadata: 0,
            dimension: 0,
            dimensionValue: 0,
            facts: 0,
            aggregatedFacts: 0,
            selectOptions: 0,
          },
        },
      });
      // Vérifie qu'on a bien sondé chaque schéma de chaque catalogue (4 paires × 6 types)
      expect(mockRedis.scan).toHaveBeenCalledTimes(24);
    });

    test('uses databaseManager.getSchemas to enumerate per-catalog schemas', async () => {
      mockRedis.scan.mockResolvedValue(['0', []]);

      await manager.getCacheStats();

      expect(mockDatabaseManager.getSchemas).toHaveBeenCalledWith('main');
      expect(mockDatabaseManager.getSchemas).toHaveBeenCalledWith('test');
      expect(mockDatabaseManager.getSchemas).toHaveBeenCalledWith('analytics');
    });

    test('propagates Redis errors during stats collection', async () => {
      mockRedis.scan.mockRejectedValueOnce(new Error('Redis scan failed'));

      await expect(manager.getCacheStats()).rejects.toThrow('Redis scan failed');
    });
  });
});

// ─── Routes d'invalidation du cache ──────────────────────────────────────────

describe('createCacheInvalidationRoutes', () => {
  let mockApp: MockApp;

  // Constructeurs de stubs pour les objets req/res Express
  const makeReq = (overrides: Partial<MockRequest> = {}): MockRequest => ({
    params: {},
    headers: {},
    ...overrides,
  });
  const makeRes = (): MockResponse => {
    const res = { status: jest.fn(), json: jest.fn() } as MockResponse;
    (res.status as jest.Mock).mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    restoreDatabaseManagerMocks();
    mockApp = { post: jest.fn(), get: jest.fn() };
    createCacheInvalidationRoutes(mockApp);
  });

  // ── Enregistrement des routes ─────────────────────────────────────────────

  describe('route registration', () => {
    test('registers POST /api/cache/invalidate/:catalog', () => {
      const paths: string[] = mockApp.post.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(paths).toContain('/api/cache/invalidate/:catalog');
    });

    test('registers POST /api/cache/invalidate/:catalog/:schema', () => {
      const paths: string[] = mockApp.post.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(paths).toContain('/api/cache/invalidate/:catalog/:schema');
    });

    test('registers POST /api/cache/invalidate-all', () => {
      const paths: string[] = mockApp.post.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(paths).toContain('/api/cache/invalidate-all');
    });

    test('registers GET /api/cache/stats', () => {
      const paths: string[] = mockApp.get.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(paths).toContain('/api/cache/stats');
    });
  });

  // ── POST /api/cache/invalidate/:catalog ──────────────────────────────────

  describe('POST /api/cache/invalidate/:catalog handler', () => {
    let handler: (req: MockRequest, res: MockResponse) => Promise<void>;

    beforeEach(() => {
      const call = mockApp.post.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/cache/invalidate/:catalog',
      );
      handler = call![2] as typeof handler;
    });

    test('invalidates a known catalog (all schemas) and returns its name', async () => {
      jest.spyOn(cacheInvalidationManager, 'invalidateCatalog').mockResolvedValueOnce(undefined);
      const res = makeRes();

      await handler(makeReq({ params: { catalog: 'main' } }), res);

      expect(cacheInvalidationManager.invalidateCatalog).toHaveBeenCalledWith('main');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, catalog: 'main', timestamp: expect.any(String) }),
      );
    });

    test('returns 404 for an unknown catalog without invalidating', async () => {
      const spy = jest
        .spyOn(cacheInvalidationManager, 'invalidateCatalog')
        .mockResolvedValueOnce(undefined);
      const res = makeRes();

      await handler(makeReq({ params: { catalog: 'nope' } }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(spy).not.toHaveBeenCalled();
    });

    test('returns 500 on invalidation error', async () => {
      jest
        .spyOn(cacheInvalidationManager, 'invalidateCatalog')
        .mockRejectedValueOnce(new Error('boom'));
      const res = makeRes();

      await handler(makeReq({ params: { catalog: 'main' } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'boom' }));
    });
  });

  // ── POST /api/cache/invalidate/:catalog/:schema ──────────────────────────

  describe('POST /api/cache/invalidate/:catalog/:schema handler', () => {
    let handler: (req: MockRequest, res: MockResponse) => Promise<void>;

    beforeEach(() => {
      const call = mockApp.post.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/cache/invalidate/:catalog/:schema',
      );
      handler = call![2] as typeof handler;
    });

    test('invalidates a known (catalog, schema) and returns both', async () => {
      jest.spyOn(cacheInvalidationManager, 'invalidateCatalog').mockResolvedValueOnce(undefined);
      const res = makeRes();

      await handler(makeReq({ params: { catalog: 'main', schema: 'analytics' } }), res);

      expect(cacheInvalidationManager.invalidateCatalog).toHaveBeenCalledWith('main', 'analytics');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          catalog: 'main',
          schema: 'analytics',
          timestamp: expect.any(String),
        }),
      );
    });

    test('returns 404 for an unknown catalog without invalidating', async () => {
      const spy = jest
        .spyOn(cacheInvalidationManager, 'invalidateCatalog')
        .mockResolvedValueOnce(undefined);
      const res = makeRes();

      await handler(makeReq({ params: { catalog: 'nope', schema: 'main' } }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(spy).not.toHaveBeenCalled();
    });

    test('returns 404 for an unknown schema within a known catalog', async () => {
      const spy = jest
        .spyOn(cacheInvalidationManager, 'invalidateCatalog')
        .mockResolvedValueOnce(undefined);
      const res = makeRes();

      await handler(makeReq({ params: { catalog: 'test', schema: 'nope' } }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Schema 'nope'"),
          availableSchemas: ['main'],
        }),
      );
      expect(spy).not.toHaveBeenCalled();
    });

    test('returns 500 on invalidation error', async () => {
      jest
        .spyOn(cacheInvalidationManager, 'invalidateCatalog')
        .mockRejectedValueOnce(new Error('redis down'));
      const res = makeRes();

      await handler(makeReq({ params: { catalog: 'main', schema: 'main' } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'redis down' }));
    });
  });

  // ── POST /api/cache/invalidate-all ───────────────────────────────────────

  describe('POST /api/cache/invalidate-all handler', () => {
    let handler: (req: MockRequest, res: MockResponse) => Promise<void>;

    beforeEach(() => {
      const call = mockApp.post.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/cache/invalidate-all',
      );
      handler = call![2] as typeof handler;
    });

    test('returns success with timestamp', async () => {
      jest
        .spyOn(cacheInvalidationManager, 'invalidateAllCatalogs')
        .mockResolvedValueOnce(undefined);
      const res = makeRes();

      await handler(makeReq(), res);

      expect(cacheInvalidationManager.invalidateAllCatalogs).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, timestamp: expect.any(String) }),
      );
    });

    test('returns 500 on global invalidation error', async () => {
      jest
        .spyOn(cacheInvalidationManager, 'invalidateAllCatalogs')
        .mockRejectedValueOnce(new Error('fail'));
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── GET /api/cache/stats ──────────────────────────────────────────────────

  describe('GET /api/cache/stats handler', () => {
    let handler: (req: MockRequest, res: MockResponse) => Promise<void>;

    beforeEach(() => {
      const call = mockApp.get.mock.calls.find((c: unknown[]) => c[0] === '/api/cache/stats');
      handler = call![2] as typeof handler;
    });

    test('returns nested catalog → schema → type stats with timestamp', async () => {
      const mockStats: Record<string, Record<string, Record<string, number>>> = {
        main: {
          main: {
            metadata: 2,
            dimension: 0,
            dimensionValue: 0,
            facts: 5,
            aggregatedFacts: 1,
            selectOptions: 0,
          },
          analytics: {
            metadata: 0,
            dimension: 0,
            dimensionValue: 0,
            facts: 3,
            aggregatedFacts: 0,
            selectOptions: 0,
          },
        },
      };
      jest.spyOn(cacheInvalidationManager, 'getCacheStats').mockResolvedValueOnce(mockStats);
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ stats: mockStats, timestamp: expect.any(String) }),
      );
    });

    test('returns 500 on stats collection error', async () => {
      jest
        .spyOn(cacheInvalidationManager, 'getCacheStats')
        .mockRejectedValueOnce(new Error('stats failed'));
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

// ─── Scénarios supplémentaires ────────────────────────────────────────────────

describe('CacheInvalidationManager — additional scenarios', () => {
  let manager: CacheInvalidationManagerInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    restoreDatabaseManagerMocks();
    manager = new CacheInvalidationManager();
  });

  test('handles concurrent invalidation operations without interference', async () => {
    mockRedis.scan.mockResolvedValue(['0', ['key1', 'key2']]);
    mockRedis.del.mockResolvedValue(2);

    const ops = [
      manager.invalidateCacheType('metadata', 'main', 'main'),
      manager.invalidateCacheType('dimension', 'test', 'main'),
      manager.invalidateCacheType('facts', 'analytics', 'main'),
    ];

    await expect(Promise.all(ops)).resolves.not.toThrow();
  });

  test('per-schema invalidation does not leak into other schemas of the same catalog', async () => {
    // Seules les clés du schéma "analytics" du catalogue "main" sont retournées
    const keysToDelete = ['metadata:main:analytics:k1', 'facts:main:analytics:k2'];
    mockRedis.scan.mockResolvedValueOnce(['0', keysToDelete]);
    mockRedis.del.mockResolvedValueOnce(2);

    await manager.invalidateCatalog('main', 'analytics');

    // Le motif cible un seul schéma — le SCAN ne ramène pas le schéma "main"
    expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', '*:main:analytics:*', 'COUNT', 100);
    expect(mockRedis.del).toHaveBeenCalledWith(...keysToDelete);
  });

  test('issues a single batch del for a large key set', async () => {
    // Génération d'un jeu de 10 000 clés — vérification de l'appel batch unique
    const largeKeyList: string[] = Array.from(
      { length: 10_000 },
      (_, i) => `key${i}:main:main:data`,
    );
    mockRedis.scan.mockResolvedValueOnce(['0', largeKeyList]);
    mockRedis.del.mockResolvedValueOnce(10_000);

    await manager.invalidateCatalog('main');

    expect(mockRedis.del).toHaveBeenCalledTimes(1);
    expect(mockRedis.del).toHaveBeenCalledWith(...largeKeyList);
  });

  test('propagates first error then succeeds on subsequent call', async () => {
    mockRedis.scan
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce(['0', []]);

    await expect(manager.invalidateCatalog('main')).rejects.toThrow('Temporary failure');
    await expect(manager.invalidateCatalog('main')).resolves.not.toThrow();
  });
});
