// Unit tests for cache-invalidation.js
// Uses jest.unstable_mockModule + dynamic imports because transform:{} disables Babel hoisting.
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mutable mock objects (declared before mock registration)
// ---------------------------------------------------------------------------

const mockRedis = {
  scan: jest.fn(),
  del: jest.fn(),
};

const mockConfig = {
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
  DATABASE_ROUTING: {
    ALLOWED_DATABASES: ['main', 'test', 'analytics'],
  },
};

// ---------------------------------------------------------------------------
// Register mocks BEFORE any dynamic import of the mocked modules
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../src/cache/index.js', () => ({
  redis: mockRedis,
  createRedisClient: jest.fn(),
}));

jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    cache: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Dynamic imports — loaded after mocks are registered
// ---------------------------------------------------------------------------

let CacheInvalidationManager;
let cacheInvalidationManager;
let createCacheInvalidationRoutes;

beforeAll(async () => {
  const cacheModule = await import('../../src/cache/cache-invalidation.js');
  CacheInvalidationManager = cacheModule.CacheInvalidationManager;
  cacheInvalidationManager = cacheModule.cacheInvalidationManager;
  createCacheInvalidationRoutes = cacheModule.createCacheInvalidationRoutes;
});

// ---------------------------------------------------------------------------
// CacheInvalidationManager
// ---------------------------------------------------------------------------

describe('CacheInvalidationManager', () => {
  let manager;

  beforeEach(() => {
    jest.resetAllMocks();
    manager = new CacheInvalidationManager();
  });

  // ---- Constructor ----

  describe('constructor', () => {
    test('exposes key-pattern functions for all cache types', () => {
      const expected = [
        'metadata', 'dimension', 'dimensionValue', 'facts',
        'aggregatedFacts', 'selectOptions', 'allDatabase',
      ];
      for (const type of expected) {
        expect(manager.keyPatterns[type]).toBeInstanceOf(Function);
      }
    });

    test('generates correct patterns with a database ID', () => {
      expect(manager.keyPatterns.metadata('main')).toBe('metadata:main:*');
      expect(manager.keyPatterns.dimension('test')).toBe('dimension:test:*');
      expect(manager.keyPatterns.dimensionValue('main')).toBe('dimension-value:main:*');
      expect(manager.keyPatterns.facts('analytics')).toBe('facts:analytics:*');
      expect(manager.keyPatterns.aggregatedFacts('main')).toBe('aggregated-facts:main:*');
      expect(manager.keyPatterns.selectOptions('main')).toBe('select-options:main:*');
      expect(manager.keyPatterns.allDatabase('main')).toBe('*:main:*');
    });

    test('falls back to "default" when database ID is falsy', () => {
      expect(manager.keyPatterns.facts()).toBe('facts:default:*');
      expect(manager.keyPatterns.metadata(null)).toBe('metadata:default:*');
      expect(manager.keyPatterns.metadata(undefined)).toBe('metadata:default:*');
      expect(manager.keyPatterns.metadata('')).toBe('metadata:default:*');
    });
  });

  // ---- scanKeys ----

  describe('scanKeys', () => {
    test('returns keys from a single-page scan', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', ['key1', 'key2', 'key3']]);

      const keys = await manager.scanKeys('metadata:main:*');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'metadata:main:*', 'COUNT', 100);
      expect(keys).toEqual(['key1', 'key2', 'key3']);
    });

    test('accumulates keys across multiple scan pages', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['42', ['key1', 'key2']])
        .mockResolvedValueOnce(['0', ['key3', 'key4']]);

      const keys = await manager.scanKeys('*:main:*');

      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
      expect(keys).toEqual(['key1', 'key2', 'key3', 'key4']);
    });

    test('returns empty array when no keys match', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      const keys = await manager.scanKeys('nonexistent:*');

      expect(keys).toEqual([]);
    });
  });

  // ---- invalidateDatabase ----

  describe('invalidateDatabase', () => {
    test('deletes all keys matching the database pattern', async () => {
      const keysToDelete = ['key1:main:a', 'key2:main:b'];
      mockRedis.scan.mockResolvedValueOnce(['0', keysToDelete]);
      mockRedis.del.mockResolvedValueOnce(2);

      await manager.invalidateDatabase('main');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', '*:main:*', 'COUNT', 100);
      expect(mockRedis.del).toHaveBeenCalledWith(keysToDelete);
    });

    test('skips del when no keys are found', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateDatabase('empty');

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    test('uses "default" when called without argument', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateDatabase();

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', '*:default:*', 'COUNT', 100);
    });

    test('uses "default" when null is passed', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateDatabase(null);

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', '*:default:*', 'COUNT', 100);
    });

    test('propagates Redis scan errors', async () => {
      mockRedis.scan.mockRejectedValueOnce(new Error('Redis connection failed'));

      await expect(manager.invalidateDatabase('main')).rejects.toThrow('Redis connection failed');
    });
  });

  // ---- invalidateCacheType ----

  describe('invalidateCacheType', () => {
    test('deletes keys for the specified cache type and database', async () => {
      const keys = ['metadata:main:field1', 'metadata:main:field2'];
      mockRedis.scan.mockResolvedValueOnce(['0', keys]);
      mockRedis.del.mockResolvedValueOnce(2);

      await manager.invalidateCacheType('metadata', 'main');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'metadata:main:*', 'COUNT', 100);
      expect(mockRedis.del).toHaveBeenCalledWith(keys);
    });

    test('throws for an unknown cache type', async () => {
      await expect(manager.invalidateCacheType('unknown', 'main'))
        .rejects.toThrow('Unknown cache type: unknown');
    });

    test('uses "default" when database is not specified', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateCacheType('facts');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'facts:default:*', 'COUNT', 100);
    });

    test('skips del when no matching keys exist', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      await manager.invalidateCacheType('dimension', 'test');

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    test('handles all supported cache types without error', async () => {
      const types = ['metadata', 'dimension', 'dimensionValue', 'facts', 'aggregatedFacts', 'selectOptions'];
      for (const type of types) {
        mockRedis.scan.mockResolvedValueOnce(['0', []]);
        await expect(manager.invalidateCacheType(type, 'main')).resolves.not.toThrow();
      }
    });

    test('propagates Redis errors', async () => {
      mockRedis.scan.mockRejectedValueOnce(new Error('Scan failed'));

      await expect(manager.invalidateCacheType('metadata', 'main')).rejects.toThrow('Scan failed');
    });
  });

  // ---- invalidateAllDatabases ----

  describe('invalidateAllDatabases', () => {
    test('calls invalidateDatabase for every configured database', async () => {
      const spy = jest.spyOn(manager, 'invalidateDatabase').mockResolvedValue();

      await manager.invalidateAllDatabases();

      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenCalledWith('main');
      expect(spy).toHaveBeenCalledWith('test');
      expect(spy).toHaveBeenCalledWith('analytics');
    });

    test('does not throw when individual databases fail', async () => {
      jest.spyOn(manager, 'invalidateDatabase')
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('test db error'))
        .mockResolvedValueOnce();

      await expect(manager.invalidateAllDatabases()).resolves.not.toThrow();
    });

    test('propagates error when ALLOWED_DATABASES is not iterable', async () => {
      const original = mockConfig.DATABASE_ROUTING.ALLOWED_DATABASES;
      mockConfig.DATABASE_ROUTING.ALLOWED_DATABASES = null;

      try {
        await expect(manager.invalidateAllDatabases()).rejects.toThrow();
      } finally {
        mockConfig.DATABASE_ROUTING.ALLOWED_DATABASES = original;
      }
    });
  });

  // ---- getCacheStats ----

  describe('getCacheStats', () => {
    test('returns key counts per type per database', async () => {
      // 3 databases × 6 types (excl. allDatabase) = 18 scan calls
      // Order follows Object.entries(keyPatterns): metadata, dimension, dimensionValue, facts, aggregatedFacts, selectOptions
      const scanResults = [
        // main: 2, 1, 0, 3, 0, 1
        ['0', ['m1', 'm2']], ['0', ['d1']], ['0', []], ['0', ['f1', 'f2', 'f3']], ['0', []], ['0', ['s1']],
        // test: 1, 0, 0, 1, 0, 0
        ['0', ['m3']], ['0', []], ['0', []], ['0', ['f4']], ['0', []], ['0', []],
        // analytics: all 0
        ['0', []], ['0', []], ['0', []], ['0', []], ['0', []], ['0', []],
      ];
      for (const result of scanResults) {
        mockRedis.scan.mockResolvedValueOnce(result);
      }

      const stats = await manager.getCacheStats();

      expect(stats).toEqual({
        main:      { metadata: 2, dimension: 1, dimensionValue: 0, facts: 3, aggregatedFacts: 0, selectOptions: 1 },
        test:      { metadata: 1, dimension: 0, dimensionValue: 0, facts: 1, aggregatedFacts: 0, selectOptions: 0 },
        analytics: { metadata: 0, dimension: 0, dimensionValue: 0, facts: 0, aggregatedFacts: 0, selectOptions: 0 },
      });
    });

    test('propagates Redis errors during stats collection', async () => {
      mockRedis.scan.mockRejectedValueOnce(new Error('Redis scan failed'));

      await expect(manager.getCacheStats()).rejects.toThrow('Redis scan failed');
    });
  });
});

// ---------------------------------------------------------------------------
// requireAdminKey middleware (tested via route registration)
// ---------------------------------------------------------------------------

describe('requireAdminKey middleware', () => {
  let adminMiddleware;
  const next = jest.fn();

  const makeReq = (headers = {}) => ({ headers, params: {} });
  const makeRes = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.ADMIN_API_KEY;
    const mockApp = { post: jest.fn(), get: jest.fn() };
    createCacheInvalidationRoutes(mockApp);
    adminMiddleware = mockApp.post.mock.calls[0][1];
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  test('returns 503 when ADMIN_API_KEY env var is not set', () => {
    const res = makeRes();
    adminMiddleware(makeReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when x-admin-key header is absent', () => {
    process.env.ADMIN_API_KEY = 'secret';
    const res = makeRes();
    adminMiddleware(makeReq({}), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when x-admin-key is wrong', () => {
    process.env.ADMIN_API_KEY = 'secret';
    const res = makeRes();
    adminMiddleware(makeReq({ 'x-admin-key': 'wrong' }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when x-admin-key matches ADMIN_API_KEY', () => {
    process.env.ADMIN_API_KEY = 'secret';
    const res = makeRes();
    adminMiddleware(makeReq({ 'x-admin-key': 'secret' }), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createCacheInvalidationRoutes
// ---------------------------------------------------------------------------

describe('createCacheInvalidationRoutes', () => {
  let mockApp;

  const makeReq = (overrides = {}) => ({ params: {}, headers: {}, ...overrides });
  const makeRes = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    mockApp = { post: jest.fn(), get: jest.fn() };
    createCacheInvalidationRoutes(mockApp);
  });

  describe('route registration', () => {
    test('registers POST /api/cache/invalidate/:database', () => {
      const paths = mockApp.post.mock.calls.map(c => c[0]);
      expect(paths).toContain('/api/cache/invalidate/:database');
    });

    test('registers POST /api/cache/invalidate-all', () => {
      const paths = mockApp.post.mock.calls.map(c => c[0]);
      expect(paths).toContain('/api/cache/invalidate-all');
    });

    test('registers GET /api/cache/stats', () => {
      const paths = mockApp.get.mock.calls.map(c => c[0]);
      expect(paths).toContain('/api/cache/stats');
    });
  });

  describe('POST /api/cache/invalidate/:database handler', () => {
    let handler;

    beforeEach(() => {
      const call = mockApp.post.mock.calls.find(c => c[0] === '/api/cache/invalidate/:database');
      handler = call[2];
    });

    test('returns success with database name and timestamp', async () => {
      jest.spyOn(cacheInvalidationManager, 'invalidateDatabase').mockResolvedValueOnce();
      const res = makeRes();

      await handler(makeReq({ params: { database: 'main' } }), res);

      expect(cacheInvalidationManager.invalidateDatabase).toHaveBeenCalledWith('main');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, database: 'main', timestamp: expect.any(String) })
      );
    });

    test('returns 500 on invalidation error', async () => {
      jest.spyOn(cacheInvalidationManager, 'invalidateDatabase').mockRejectedValueOnce(new Error('boom'));
      const res = makeRes();

      await handler(makeReq({ params: { database: 'main' } }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'boom' }));
    });
  });

  describe('POST /api/cache/invalidate-all handler', () => {
    let handler;

    beforeEach(() => {
      const call = mockApp.post.mock.calls.find(c => c[0] === '/api/cache/invalidate-all');
      handler = call[2];
    });

    test('returns success with timestamp', async () => {
      jest.spyOn(cacheInvalidationManager, 'invalidateAllDatabases').mockResolvedValueOnce();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(cacheInvalidationManager.invalidateAllDatabases).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, timestamp: expect.any(String) })
      );
    });

    test('returns 500 on global invalidation error', async () => {
      jest.spyOn(cacheInvalidationManager, 'invalidateAllDatabases').mockRejectedValueOnce(new Error('fail'));
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /api/cache/stats handler', () => {
    let handler;

    beforeEach(() => {
      const call = mockApp.get.mock.calls.find(c => c[0] === '/api/cache/stats');
      handler = call[2];
    });

    test('returns stats with timestamp', async () => {
      const mockStats = { main: { metadata: 2, dimension: 0, dimensionValue: 0, facts: 5, aggregatedFacts: 1, selectOptions: 0 } };
      jest.spyOn(cacheInvalidationManager, 'getCacheStats').mockResolvedValueOnce(mockStats);
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ stats: mockStats, timestamp: expect.any(String) })
      );
    });

    test('returns 500 on stats collection error', async () => {
      jest.spyOn(cacheInvalidationManager, 'getCacheStats').mockRejectedValueOnce(new Error('stats failed'));
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

// ---------------------------------------------------------------------------
// Additional scenarios
// ---------------------------------------------------------------------------

describe('CacheInvalidationManager — additional scenarios', () => {
  let manager;

  beforeEach(() => {
    jest.resetAllMocks();
    manager = new CacheInvalidationManager();
  });

  test('handles concurrent invalidation operations without interference', async () => {
    mockRedis.scan.mockResolvedValue(['0', ['key1', 'key2']]);
    mockRedis.del.mockResolvedValue(2);

    const ops = [
      manager.invalidateCacheType('metadata', 'main'),
      manager.invalidateCacheType('dimension', 'test'),
      manager.invalidateCacheType('facts', 'analytics'),
    ];

    await expect(Promise.all(ops)).resolves.not.toThrow();
  });

  test('issues a single batch del for a large key set', async () => {
    const largeKeyList = Array.from({ length: 10_000 }, (_, i) => `key${i}:main:data`);
    mockRedis.scan.mockResolvedValueOnce(['0', largeKeyList]);
    mockRedis.del.mockResolvedValueOnce(10_000);

    await manager.invalidateDatabase('main');

    expect(mockRedis.del).toHaveBeenCalledTimes(1);
    expect(mockRedis.del).toHaveBeenCalledWith(largeKeyList);
  });

  test('propagates first error then succeeds on subsequent call', async () => {
    mockRedis.scan
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce(['0', []]);

    await expect(manager.invalidateDatabase('main')).rejects.toThrow('Temporary failure');
    await expect(manager.invalidateDatabase('main')).resolves.not.toThrow();
  });
});
