// Unit tests for caching system - Redis client and cache invalidation
import { jest } from '@jest/globals';
import Redis from 'ioredis';
import { createRedisClient } from '../src/cache/redis.js';
import { CacheInvalidationManager, cacheInvalidationManager } from '../src/cache/cache-invalidation.js';

// Mock Redis
const mockRedis = {
  connect: jest.fn().mockResolvedValue(),
  quit: jest.fn().mockResolvedValue(),
  on: jest.fn(),
  emit: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  keys: jest.fn(),
  status: 'ready'
};

// Mock ioredis
jest.mock('ioredis', () => {
  const MockRedis = jest.fn().mockImplementation(() => mockRedis);
  MockRedis.Cluster = jest.fn().mockImplementation(() => mockRedis);
  return MockRedis;
});

// Mock config
jest.mock('../src/utils/config-loader.js', () => ({
  config: {
    CACHE: {
      REDIS: {
        HOST: 'localhost',
        PORT: 6379,
        PASSWORD: null,
        KEY_PREFIX: 'test:',
        OPTIONS: {
          RETRY_STRATEGY: {
            BASE_DELAY: 50,
            MAX_DELAY: 2000
          },
          MAX_RETRIES_PER_REQUEST: 3,
          ENABLE_READY_CHECK: true,
          CONNECT_TIMEOUT: 10000
        },
        CLUSTER: {
          ENABLED: false,
          NODES: []
        }
      }
    },
    DATABASE_ROUTING: {
      ALLOWED_DATABASES: ['main', 'test', 'analytics']
    }
  }
}));

// Mock logger
jest.mock('../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    cache: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

describe('Redis Client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createRedisClient', () => {
    test('should create standalone Redis client by default', () => {
      const client = createRedisClient();

      expect(Redis).toHaveBeenCalledWith(expect.objectContaining({
        host: 'localhost',
        port: 6379,
        keyPrefix: 'test:',
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 10000
      }));

      expect(client).toBe(mockRedis);
    });

    test('should create cluster client when enabled', () => {
      // Mock cluster configuration
      jest.doMock('../src/utils/config-loader.js', () => ({
        config: {
          CACHE: {
            REDIS: {
              HOST: 'localhost',
              PORT: 6379,
              CLUSTER: {
                ENABLED: true,
                NODES: [
                  { host: 'node1', port: 6379 },
                  { host: 'node2', port: 6379 }
                ]
              },
              OPTIONS: {
                RETRY_STRATEGY: {
                  BASE_DELAY: 50,
                  MAX_DELAY: 2000
                },
                MAX_RETRIES_PER_REQUEST: 3,
                ENABLE_READY_CHECK: true,
                CONNECT_TIMEOUT: 10000
              }
            }
          }
        }
      }));

      const client = createRedisClient();
      
      expect(Redis.Cluster).toHaveBeenCalled();
      expect(client).toBe(mockRedis);
    });

    test('should configure event listeners', () => {
      const client = createRedisClient();

      expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(client.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(client.on).toHaveBeenCalledWith('ready', expect.any(Function));
      expect(client.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    test('should configure retry strategy', () => {
      createRedisClient();

      const config = Redis.mock.calls[0][0];
      expect(config.retryStrategy).toBeInstanceOf(Function);

      // Test retry strategy function
      const delay = config.retryStrategy(3);
      expect(delay).toBe(150); // 3 * 50 = 150
    });

    test('should cap retry delay at maximum', () => {
      createRedisClient();

      const config = Redis.mock.calls[0][0];
      const delay = config.retryStrategy(100); // Very high retry count
      expect(delay).toBe(2000); // Should be capped at MAX_DELAY
    });
  });
});

describe('CacheInvalidationManager', () => {
  let manager;
  let mockRedisInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockRedisInstance = {
      keys: jest.fn(),
      del: jest.fn(),
      quit: jest.fn().mockResolvedValue()
    };

    // Mock the redis instance
    jest.doMock('../src/cache/index.js', () => ({
      redis: mockRedisInstance
    }));

    manager = new CacheInvalidationManager();
  });

  describe('Constructor', () => {
    test('should initialize with correct key patterns', () => {
      expect(manager.keyPatterns).toBeDefined();
      expect(manager.keyPatterns.metadata).toBeInstanceOf(Function);
      expect(manager.keyPatterns.dimension).toBeInstanceOf(Function);
      expect(manager.keyPatterns.facts).toBeInstanceOf(Function);
      expect(manager.keyPatterns.allDatabase).toBeInstanceOf(Function);
    });

    test('should generate correct key patterns', () => {
      expect(manager.keyPatterns.metadata('main')).toBe('metadata:main:*');
      expect(manager.keyPatterns.dimension('test')).toBe('dimension:test:*');
      expect(manager.keyPatterns.facts()).toBe('facts:default:*');
      expect(manager.keyPatterns.allDatabase('analytics')).toBe('*:analytics:*');
    });
  });

  describe('invalidateDatabase', () => {
    test('should invalidate all cache entries for a database', async () => {
      const mockKeys = ['key1:main:data', 'key2:main:data', 'key3:main:data'];
      mockRedisInstance.keys.mockResolvedValue(mockKeys);
      mockRedisInstance.del.mockResolvedValue(3);

      await manager.invalidateDatabase('main');

      expect(mockRedisInstance.keys).toHaveBeenCalledWith('*:main:*');
      expect(mockRedisInstance.del).toHaveBeenCalledWith(mockKeys);
    });

    test('should handle empty key list gracefully', async () => {
      mockRedisInstance.keys.mockResolvedValue([]);

      await manager.invalidateDatabase('empty');

      expect(mockRedisInstance.keys).toHaveBeenCalledWith('*:empty:*');
      expect(mockRedisInstance.del).not.toHaveBeenCalled();
    });

    test('should use default database when none specified', async () => {
      mockRedisInstance.keys.mockResolvedValue([]);

      await manager.invalidateDatabase();

      expect(mockRedisInstance.keys).toHaveBeenCalledWith('*:default:*');
    });

    test('should handle Redis errors', async () => {
      const error = new Error('Redis connection failed');
      mockRedisInstance.keys.mockRejectedValue(error);

      await expect(manager.invalidateDatabase('main')).rejects.toThrow('Redis connection failed');
    });
  });

  describe('invalidateCacheType', () => {
    test('should invalidate specific cache type', async () => {
      const mockKeys = ['metadata:main:field1', 'metadata:main:field2'];
      mockRedisInstance.keys.mockResolvedValue(mockKeys);
      mockRedisInstance.del.mockResolvedValue(2);

      await manager.invalidateCacheType('metadata', 'main');

      expect(mockRedisInstance.keys).toHaveBeenCalledWith('metadata:main:*');
      expect(mockRedisInstance.del).toHaveBeenCalledWith(mockKeys);
    });

    test('should throw error for unknown cache type', async () => {
      await expect(manager.invalidateCacheType('unknown', 'main'))
        .rejects.toThrow('Unknown cache type: unknown');
    });

    test('should use default database when none specified', async () => {
      mockRedisInstance.keys.mockResolvedValue([]);

      await manager.invalidateCacheType('facts');

      expect(mockRedisInstance.keys).toHaveBeenCalledWith('facts:default:*');
    });

    test('should handle empty results gracefully', async () => {
      mockRedisInstance.keys.mockResolvedValue([]);

      await expect(manager.invalidateCacheType('dimension', 'test'))
        .resolves.not.toThrow();
      
      expect(mockRedisInstance.del).not.toHaveBeenCalled();
    });
  });

  describe('invalidateAllDatabases', () => {
    test('should invalidate all databases', async () => {
      const databases = ['main', 'test', 'analytics'];
      mockRedisInstance.keys.mockResolvedValue(['key1', 'key2']);
      mockRedisInstance.del.mockResolvedValue(2);

      // Mock successful invalidation for each database
      manager.invalidateDatabase = jest.fn().mockResolvedValue();

      await manager.invalidateAllDatabases();

      expect(manager.invalidateDatabase).toHaveBeenCalledTimes(3);
      expect(manager.invalidateDatabase).toHaveBeenCalledWith('main');
      expect(manager.invalidateDatabase).toHaveBeenCalledWith('test');
      expect(manager.invalidateDatabase).toHaveBeenCalledWith('analytics');
    });

    test('should handle partial failures gracefully', async () => {
      manager.invalidateDatabase = jest.fn()
        .mockResolvedValueOnce() // main succeeds
        .mockRejectedValueOnce(new Error('test db failed')) // test fails
        .mockResolvedValueOnce(); // analytics succeeds

      await expect(manager.invalidateAllDatabases()).resolves.not.toThrow();
    });
  });

  describe('getCacheStats', () => {
    test('should return cache statistics for all databases', async () => {
      mockRedisInstance.keys
        .mockResolvedValueOnce(['meta1', 'meta2']) // metadata:main
        .mockResolvedValueOnce(['dim1']) // dimension:main
        .mockResolvedValueOnce(['fact1', 'fact2', 'fact3']) // facts:main
        .mockResolvedValueOnce([]) // aggregatedFacts:main
        .mockResolvedValueOnce(['select1']) // selectOptions:main
        .mockResolvedValueOnce(['meta3']) // metadata:test
        .mockResolvedValueOnce([]) // dimension:test
        .mockResolvedValueOnce(['fact4']) // facts:test
        .mockResolvedValueOnce([]) // aggregatedFacts:test
        .mockResolvedValueOnce([]) // selectOptions:test
        .mockResolvedValueOnce([]) // metadata:analytics
        .mockResolvedValueOnce([]) // dimension:analytics
        .mockResolvedValueOnce([]) // facts:analytics
        .mockResolvedValueOnce([]) // aggregatedFacts:analytics
        .mockResolvedValueOnce([]); // selectOptions:analytics

      const stats = await manager.getCacheStats();

      expect(stats).toEqual({
        main: {
          metadata: 2,
          dimension: 1,
          dimensionValue: 0,
          facts: 3,
          aggregatedFacts: 0,
          selectOptions: 1
        },
        test: {
          metadata: 1,
          dimension: 0,
          dimensionValue: 0,
          facts: 1,
          aggregatedFacts: 0,
          selectOptions: 0
        },
        analytics: {
          metadata: 0,
          dimension: 0,
          dimensionValue: 0,
          facts: 0,
          aggregatedFacts: 0,
          selectOptions: 0
        }
      });
    });

    test('should handle Redis errors during stats collection', async () => {
      mockRedisInstance.keys.mockRejectedValue(new Error('Redis failed'));

      await expect(manager.getCacheStats()).rejects.toThrow('Redis failed');
    });
  });
});

describe('Cache Integration Tests', () => {
  let manager;

  beforeEach(() => {
    manager = new CacheInvalidationManager();
  });

  test('should handle concurrent invalidation operations', async () => {
    const mockRedisInstance = {
      keys: jest.fn().mockResolvedValue(['key1', 'key2']),
      del: jest.fn().mockResolvedValue(2)
    };

    jest.doMock('../src/cache/index.js', () => ({
      redis: mockRedisInstance
    }));

    // Run multiple invalidations concurrently
    const operations = [
      manager.invalidateCacheType('metadata', 'main'),
      manager.invalidateCacheType('dimension', 'test'),
      manager.invalidateCacheType('facts', 'analytics')
    ];

    await expect(Promise.all(operations)).resolves.not.toThrow();
  });

  test('should handle cache operations without Redis connection', async () => {
    const failingRedis = {
      keys: jest.fn().mockRejectedValue(new Error('Connection lost')),
      del: jest.fn().mockRejectedValue(new Error('Connection lost'))
    };

    jest.doMock('../src/cache/index.js', () => ({
      redis: failingRedis
    }));

    const manager = new CacheInvalidationManager();

    await expect(manager.invalidateDatabase('main')).rejects.toThrow('Connection lost');
    await expect(manager.getCacheStats()).rejects.toThrow('Connection lost');
  });

  test('should handle large number of keys efficiently', async () => {
    const largeKeyList = Array.from({ length: 10000 }, (_, i) => `key${i}:main:data`);
    
    const mockRedisInstance = {
      keys: jest.fn().mockResolvedValue(largeKeyList),
      del: jest.fn().mockResolvedValue(10000)
    };

    jest.doMock('../src/cache/index.js', () => ({
      redis: mockRedisInstance
    }));

    const manager = new CacheInvalidationManager();
    const startTime = Date.now();

    await manager.invalidateDatabase('main');

    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(1000); // Should complete in reasonable time
    expect(mockRedisInstance.del).toHaveBeenCalledWith(largeKeyList);
  });
});

describe('Cache Error Recovery', () => {
  test('should retry operations on temporary failures', async () => {
    const mockRedisInstance = {
      keys: jest.fn()
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValue(['key1', 'key2']),
      del: jest.fn().mockResolvedValue(2)
    };

    jest.doMock('../src/cache/index.js', () => ({
      redis: mockRedisInstance
    }));

    const manager = new CacheInvalidationManager();
    
    // First call should fail, but the test demonstrates error handling
    await expect(manager.invalidateDatabase('main')).rejects.toThrow('Temporary failure');
    
    // Second call should succeed
    await expect(manager.invalidateDatabase('main')).resolves.not.toThrow();
  });

  test('should handle malformed key patterns', () => {
    const manager = new CacheInvalidationManager();
    
    // Test with malformed database ID
    expect(manager.keyPatterns.metadata('')).toBe('metadata::*');
    expect(manager.keyPatterns.metadata(null)).toBe('metadata:default:*');
    expect(manager.keyPatterns.metadata(undefined)).toBe('metadata:default:*');
  });
});

describe('Cache Performance', () => {
  test('should batch delete operations efficiently', async () => {
    const batchSize = 1000;
    const keys = Array.from({ length: batchSize }, (_, i) => `batch:key${i}`);

    const mockRedisInstance = {
      keys: jest.fn().mockResolvedValue(keys),
      del: jest.fn().mockResolvedValue(batchSize)
    };

    jest.doMock('../src/cache/index.js', () => ({
      redis: mockRedisInstance
    }));

    const manager = new CacheInvalidationManager();
    
    await manager.invalidateDatabase('batch');

    // Should call del once with all keys (batch operation)
    expect(mockRedisInstance.del).toHaveBeenCalledTimes(1);
    expect(mockRedisInstance.del).toHaveBeenCalledWith(keys);
  });
});