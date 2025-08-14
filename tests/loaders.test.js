// Unit tests for data loaders
import { jest } from '@jest/globals';
import { createLoaders, createLoadersForRequest } from '../src/loaders/index.js';
import { BaseQueryLoader } from '../src/loaders/base-loader.js';

// Mock dependencies
const mockPool = {
  acquire: jest.fn(),
  release: jest.fn()
};

const mockConnection = {
  all: jest.fn(),
  run: jest.fn(),
  getAsJsonArray: jest.fn(),
  getWithMetadata: jest.fn()
};

const mockDatabaseManager = {
  getPool: jest.fn().mockReturnValue(mockPool)
};

jest.mock('../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager
}));

jest.mock('../src/utils/cache.js', () => ({
  withCache: jest.fn().mockImplementation(async (key, loader) => await loader())
}));

jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  }
}));

jest.mock('../src/utils/config-loader.js', () => ({
  config: {
    API: {
      LOADERS: {
        DEFAULT_CACHE_TIMEOUT: 300000,
        BATCH_SIZE: 10
      }
    }
  }
}));

// Mock DataLoader
const mockDataLoader = {
  load: jest.fn(),
  loadMany: jest.fn(),
  clear: jest.fn(),
  clearAll: jest.fn(),
  prime: jest.fn()
};

jest.mock('dataloader', () => {
  return jest.fn().mockImplementation(() => mockDataLoader);
});

// Mock individual loader creation functions
jest.mock('../src/loaders/metadata.js', () => ({
  createMetadataLoader: jest.fn(() => mockDataLoader)
}));

jest.mock('../src/loaders/dimension.js', () => ({
  createDimensionLoader: jest.fn(() => mockDataLoader),
  createDimensionValueLoader: jest.fn(() => mockDataLoader)
}));

jest.mock('../src/loaders/fact.js', () => ({
  createFactLoader: jest.fn(() => mockDataLoader),
  createFactWithCountLoader: jest.fn(() => mockDataLoader),
  createFactWithMetadataLoader: jest.fn(() => mockDataLoader)
}));

jest.mock('../src/loaders/aggregated-facts.js', () => ({
  createAggregatedFactsLoader: jest.fn(() => mockDataLoader),
  createAggregatedFactsWithMetadataLoader: jest.fn(() => mockDataLoader),
  createAggregatedFactsWithCountLoader: jest.fn(() => mockDataLoader)
}));

jest.mock('../src/loaders/select-options.js', () => ({
  createSelectOptionsLoader: jest.fn(() => mockDataLoader)
}));

describe('BaseQueryLoader', () => {
  let baseLoader;

  beforeEach(() => {
    jest.clearAllMocks();
    baseLoader = new BaseQueryLoader({
      batchSize: 10,
      cachePrefix: 'test',
      cache: true,
      databaseId: 'main'
    });
  });

  describe('Constructor', () => {
    test('should initialize with default configuration', () => {
      const loader = new BaseQueryLoader();
      
      expect(loader.batchSize).toBe(5);
      expect(loader.cachePrefix).toBe('default');
      expect(loader.cacheEnabled).toBe(true);
      expect(loader.databaseId).toBe(null);
    });

    test('should initialize with custom configuration', () => {
      const config = {
        batchSize: 15,
        cachePrefix: 'custom',
        cache: false,
        databaseId: 'analytics'
      };
      
      const loader = new BaseQueryLoader(config);
      
      expect(loader.batchSize).toBe(15);
      expect(loader.cachePrefix).toBe('custom');
      expect(loader.cacheEnabled).toBe(false);
      expect(loader.databaseId).toBe('analytics');
    });
  });

  describe('executeWithConnection', () => {
    test('should acquire and release connection properly', async () => {
      mockPool.acquire.mockResolvedValue(mockConnection);
      const queryFn = jest.fn().mockResolvedValue('test result');

      const result = await baseLoader.executeWithConnection(queryFn);

      expect(mockDatabaseManager.getPool).toHaveBeenCalledWith('main');
      expect(mockPool.acquire).toHaveBeenCalled();
      expect(queryFn).toHaveBeenCalledWith(mockConnection);
      expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
      expect(result).toBe('test result');
    });

    test('should release connection even on error', async () => {
      mockPool.acquire.mockResolvedValue(mockConnection);
      const queryFn = jest.fn().mockRejectedValue(new Error('Query failed'));

      await expect(baseLoader.executeWithConnection(queryFn)).rejects.toThrow('Query failed');
      
      expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
    });

    test('should handle connection acquisition failure', async () => {
      mockPool.acquire.mockRejectedValue(new Error('Pool exhausted'));
      const queryFn = jest.fn();

      await expect(baseLoader.executeWithConnection(queryFn)).rejects.toThrow('Pool exhausted');
      
      expect(queryFn).not.toHaveBeenCalled();
    });

    test('should use default database when databaseId is null', async () => {
      const loader = new BaseQueryLoader({ databaseId: null });
      mockPool.acquire.mockResolvedValue(mockConnection);
      const queryFn = jest.fn().mockResolvedValue('result');

      await loader.executeWithConnection(queryFn);

      expect(mockDatabaseManager.getPool).toHaveBeenCalledWith(null);
    });
  });

  describe('loadWithCache', () => {
    const { withCache } = require('../src/utils/cache.js');

    test('should use cache when enabled', async () => {
      const loader = jest.fn().mockResolvedValue('cached result');
      withCache.mockImplementation(async (key, loaderFn) => await loaderFn());

      const result = await baseLoader.loadWithCache('test-key', loader);

      expect(withCache).toHaveBeenCalledWith(
        'test:main:["test-key"]',
        loader,
        baseLoader.cacheTimeout
      );
      expect(result).toBe('cached result');
    });

    test('should bypass cache when disabled', async () => {
      const loader = new BaseQueryLoader({ cache: false });
      const loaderFn = jest.fn().mockResolvedValue('direct result');

      const result = await loader.loadWithCache('test-key', loaderFn);

      expect(withCache).not.toHaveBeenCalled();
      expect(loaderFn).toHaveBeenCalled();
      expect(result).toBe('direct result');
    });

    test('should fallback to direct loading on cache error', async () => {
      withCache.mockRejectedValue(new Error('Cache failed'));
      const loaderFn = jest.fn().mockResolvedValue('fallback result');

      const result = await baseLoader.loadWithCache('test-key', loaderFn);

      expect(result).toBe('fallback result');
      expect(loaderFn).toHaveBeenCalled();
    });

    test('should generate correct cache key with database ID', async () => {
      const loaderFn = jest.fn().mockResolvedValue('result');
      const complexKey = { field: 'value', nested: { prop: 123 } };

      await baseLoader.loadWithCache(complexKey, loaderFn);

      expect(withCache).toHaveBeenCalledWith(
        `test:main:${JSON.stringify(complexKey)}`,
        loaderFn,
        baseLoader.cacheTimeout
      );
    });

    test('should use default database in cache key when databaseId is null', async () => {
      const loader = new BaseQueryLoader({ databaseId: null });
      const loaderFn = jest.fn().mockResolvedValue('result');

      await loader.loadWithCache('key', loaderFn);

      expect(withCache).toHaveBeenCalledWith(
        'default:default:["key"]',
        loaderFn,
        expect.any(Number)
      );
    });
  });
});

describe('Loader Factory Functions', () => {
  const {
    createMetadataLoader,
    createDimensionLoader,
    createDimensionValueLoader,
    createFactLoader,
    createFactWithCountLoader,
    createFactWithMetadataLoader,
    createAggregatedFactsLoader,
    createAggregatedFactsWithMetadataLoader,
    createAggregatedFactsWithCountLoader,
    createSelectOptionsLoader
  } = require('../src/loaders/metadata.js');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createLoaders', () => {
    test('should create all loaders with default database', () => {
      const loaders = createLoaders();

      expect(loaders).toHaveProperty('metadata');
      expect(loaders).toHaveProperty('dimension');
      expect(loaders).toHaveProperty('dimensionValue');
      expect(loaders).toHaveProperty('fact');
      expect(loaders).toHaveProperty('factWithCount');
      expect(loaders).toHaveProperty('factWithMetadata');
      expect(loaders).toHaveProperty('aggregatedFacts');
      expect(loaders).toHaveProperty('aggregatedFactsWithMetadata');
      expect(loaders).toHaveProperty('aggregatedFactsWithCount');
      expect(loaders).toHaveProperty('selectOptions');
      expect(loaders).toHaveProperty('clearAll');
      expect(loaders).toHaveProperty('prime');
    });

    test('should create all loaders with specific database', () => {
      const databaseId = 'analytics';
      const loaders = createLoaders(databaseId);

      // Verify all loader creation functions were called with the database ID
      const mockLoaderCreators = [
        require('../src/loaders/metadata.js').createMetadataLoader,
        require('../src/loaders/dimension.js').createDimensionLoader,
        require('../src/loaders/dimension.js').createDimensionValueLoader,
        require('../src/loaders/fact.js').createFactLoader,
        require('../src/loaders/fact.js').createFactWithCountLoader,
        require('../src/loaders/fact.js').createFactWithMetadataLoader,
        require('../src/loaders/aggregated-facts.js').createAggregatedFactsLoader,
        require('../src/loaders/aggregated-facts.js').createAggregatedFactsWithMetadataLoader,
        require('../src/loaders/aggregated-facts.js').createAggregatedFactsWithCountLoader,
        require('../src/loaders/select-options.js').createSelectOptionsLoader
      ];

      mockLoaderCreators.forEach(mockCreator => {
        expect(mockCreator).toHaveBeenCalledWith(databaseId);
      });
    });

    test('should provide clearAll functionality', () => {
      const loaders = createLoaders();
      
      loaders.clearAll();

      // Should call clearAll on all individual loaders
      expect(mockDataLoader.clearAll).toHaveBeenCalledTimes(10); // 10 different loaders
    });

    test('should provide prime functionality', async () => {
      const loaders = createLoaders();
      const initialData = {
        metadata: [{ key: 'field1', value: { name: 'field1', type: 'string' } }],
        dimensions: [{ key: 'country', value: [{ value: '1', label: 'USA' }] }],
        facts: [{ key: 'fact1', value: { id: 1, value: 100 } }]
      };

      await loaders.prime(initialData);

      expect(mockDataLoader.prime).toHaveBeenCalledWith('field1', { name: 'field1', type: 'string' });
      expect(mockDataLoader.prime).toHaveBeenCalledWith('country', [{ value: '1', label: 'USA' }]);
      expect(mockDataLoader.prime).toHaveBeenCalledWith('fact1', { id: 1, value: 100 });
    });

    test('should handle empty prime data gracefully', async () => {
      const loaders = createLoaders();
      
      await expect(loaders.prime()).resolves.not.toThrow();
      await expect(loaders.prime({})).resolves.not.toThrow();
    });
  });

  describe('createLoadersForRequest', () => {
    test('should create new loaders for each request', () => {
      const loaders1 = createLoadersForRequest('db1');
      const loaders2 = createLoadersForRequest('db2');

      // Should be different instances
      expect(loaders1).not.toBe(loaders2);
      
      // But should have same structure
      expect(Object.keys(loaders1)).toEqual(Object.keys(loaders2));
    });

    test('should forward database ID correctly', () => {
      createLoadersForRequest('test-db');

      // Should call createLoaders with the same database ID
      expect(require('../src/loaders/metadata.js').createMetadataLoader)
        .toHaveBeenCalledWith('test-db');
    });
  });
});

describe('Loader Integration Tests', () => {
  test('should handle database routing correctly', async () => {
    const loader = new BaseQueryLoader({ databaseId: 'analytics' });
    mockPool.acquire.mockResolvedValue(mockConnection);
    
    const queryFn = jest.fn().mockResolvedValue('analytics result');
    await loader.executeWithConnection(queryFn);

    expect(mockDatabaseManager.getPool).toHaveBeenCalledWith('analytics');
  });

  test('should handle concurrent operations correctly', async () => {
    const loader = new BaseQueryLoader();
    mockPool.acquire.mockResolvedValue(mockConnection);
    
    const operations = Array.from({ length: 5 }, (_, i) => 
      loader.executeWithConnection(async () => `result ${i}`)
    );

    const results = await Promise.all(operations);
    
    expect(results).toHaveLength(5);
    expect(mockPool.acquire).toHaveBeenCalledTimes(5);
    expect(mockPool.release).toHaveBeenCalledTimes(5);
  });

  test('should handle loader errors gracefully', async () => {
    const loader = new BaseQueryLoader();
    mockPool.acquire.mockResolvedValue(mockConnection);
    
    const errorQuery = async () => { throw new Error('DB error'); };
    const successQuery = async () => 'success';

    await expect(loader.executeWithConnection(errorQuery)).rejects.toThrow('DB error');
    await expect(loader.executeWithConnection(successQuery)).resolves.toBe('success');

    // Both operations should have released connections
    expect(mockPool.release).toHaveBeenCalledTimes(2);
  });
});

describe('Loader Performance Tests', () => {
  test('should handle batch operations efficiently', async () => {
    const loaders = createLoaders();
    const batchData = Array.from({ length: 100 }, (_, i) => ({
      key: `key${i}`,
      value: `value${i}`
    }));

    const startTime = Date.now();
    await loaders.prime({ metadata: batchData });
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(100); // Should be fast
    expect(mockDataLoader.prime).toHaveBeenCalledTimes(100);
  });

  test('should handle cache operations efficiently', async () => {
    const loader = new BaseQueryLoader({ cache: true });
    const { withCache } = require('../src/utils/cache.js');
    
    const fastLoader = jest.fn().mockResolvedValue('cached');
    withCache.mockImplementation(async (key, loaderFn, timeout) => {
      // Simulate cache hit after first call
      if (!withCache.calls) withCache.calls = 0;
      withCache.calls++;
      
      if (withCache.calls === 1) {
        return await loaderFn(); // First call loads from source
      } else {
        return 'cached'; // Subsequent calls return cached value
      }
    });

    // First call
    await loader.loadWithCache('same-key', fastLoader);
    // Second call should use cache
    await loader.loadWithCache('same-key', fastLoader);

    expect(fastLoader).toHaveBeenCalledTimes(1); // Only called once due to caching
  });
});

describe('Error Handling and Edge Cases', () => {
  test('should handle malformed cache keys', async () => {
    const loader = new BaseQueryLoader();
    const circularKey = {};
    circularKey.self = circularKey; // Create circular reference

    const loaderFn = jest.fn().mockResolvedValue('result');

    // Should not throw on circular reference
    await expect(loader.loadWithCache(circularKey, loaderFn)).rejects.toThrow();
  });

  test('should handle connection pool exhaustion', async () => {
    const loader = new BaseQueryLoader();
    mockPool.acquire.mockRejectedValue(new Error('Pool exhausted'));

    const queryFn = jest.fn();

    await expect(loader.executeWithConnection(queryFn)).rejects.toThrow('Pool exhausted');
    expect(mockPool.release).not.toHaveBeenCalled();
  });

  test('should handle database manager errors', async () => {
    const loader = new BaseQueryLoader({ databaseId: 'nonexistent' });
    mockDatabaseManager.getPool.mockImplementation(() => {
      throw new Error('Database not found');
    });

    const queryFn = jest.fn();

    await expect(loader.executeWithConnection(queryFn)).rejects.toThrow('Database not found');
  });
});