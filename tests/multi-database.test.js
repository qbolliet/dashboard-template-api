// Unit tests specifically for multiple database support functionality
import { jest } from '@jest/globals';
import { DatabaseManager } from '../src/db/database-manager.js';
import { BaseQueryLoader } from '../src/loaders/base-loader.js';
import { createLoaders } from '../src/loaders/index.js';

// Mock dependencies
jest.mock('../src/utils/config-loader.js', () => ({
  config: {
    DATABASE_ROUTING: {
      DEFAULT_DATABASE: 'main',
      ALLOWED_DATABASES: ['main', 'analytics', 'audit', 'archive'],
      ALLOW_CROSS_DATABASE_QUERIES: true
    },
    DATABASES: {
      main: {
        PATH: 'data/main.db',
        POOL: {
          MAX_CONNECTIONS: 10,
          ACQUIRE_TIMEOUT: 5000,
          CONNECTION_RETRY_DELAY: 1000,
          CONNECTION_RETRY_MAX: 3
        }
      },
      analytics: {
        PATH: 'data/analytics.db',
        POOL: {
          MAX_CONNECTIONS: 15,
          ACQUIRE_TIMEOUT: 8000,
          CONNECTION_RETRY_DELAY: 1500,
          CONNECTION_RETRY_MAX: 5
        }
      },
      audit: {
        PATH: 'data/audit.db',
        POOL: {
          MAX_CONNECTIONS: 5,
          ACQUIRE_TIMEOUT: 3000,
          CONNECTION_RETRY_DELAY: 500,
          CONNECTION_RETRY_MAX: 2
        }
      },
      archive: {
        PATH: 'data/archive.db',
        POOL: {
          MAX_CONNECTIONS: 3,
          ACQUIRE_TIMEOUT: 10000,
          CONNECTION_RETRY_DELAY: 2000,
          CONNECTION_RETRY_MAX: 3
        }
      }
    }
  }
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  statSync: jest.fn().mockReturnValue({
    size: 1024000,
    mtime: new Date('2023-01-01')
  })
}));

jest.mock('../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    database: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn()
  })
}));

// Mock DuckDBPool
const mockPools = new Map();
jest.mock('../src/db/pool.js', () => ({
  DuckDBPool: jest.fn().mockImplementation((config) => {
    const mockPool = {
      config,
      close: jest.fn().mockResolvedValue(),
      on: jest.fn(),
      available: config.maxConnections,
      using: 0,
      waiting: 0,
      acquire: jest.fn().mockResolvedValue({ id: `conn-${Date.now()}` }),
      release: jest.fn().mockResolvedValue()
    };
    mockPools.set(config.path, mockPool);
    return mockPool;
  })
}));

describe('Multiple Database Support - DatabaseManager', () => {
  let databaseManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPools.clear();
    databaseManager = new DatabaseManager();
  });

  describe('Multi-Database Initialization', () => {
    test('should initialize all configured databases', () => {
      expect(databaseManager.pools.size).toBe(4);
      expect(databaseManager.pools.has('main')).toBe(true);
      expect(databaseManager.pools.has('analytics')).toBe(true);
      expect(databaseManager.pools.has('audit')).toBe(true);
      expect(databaseManager.pools.has('archive')).toBe(true);
    });

    test('should configure different pool settings per database', () => {
      const { DuckDBPool } = require('../src/db/pool.js');
      
      // Verify each database was initialized with its specific configuration
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        maxConnections: 10
      })); // main
      
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        maxConnections: 15
      })); // analytics
      
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        maxConnections: 5
      })); // audit
      
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        maxConnections: 3
      })); // archive
    });

    test('should set correct database routing configuration', () => {
      expect(databaseManager.defaultDatabase).toBe('main');
      expect(databaseManager.allowedDatabases).toEqual(['main', 'analytics', 'audit', 'archive']);
      expect(databaseManager.allowCrossDatabase).toBe(true);
    });
  });

  describe('Database Pool Retrieval', () => {
    test('should return correct pool for each database', () => {
      const mainPool = databaseManager.getPool('main');
      const analyticsPool = databaseManager.getPool('analytics');
      const auditPool = databaseManager.getPool('audit');
      const archivePool = databaseManager.getPool('archive');

      expect(mainPool).toBeDefined();
      expect(analyticsPool).toBeDefined();
      expect(auditPool).toBeDefined();
      expect(archivePool).toBeDefined();
      
      // They should be different instances
      expect(mainPool).not.toBe(analyticsPool);
      expect(analyticsPool).not.toBe(auditPool);
    });

    test('should return default database pool when no ID specified', () => {
      const defaultPool = databaseManager.getPool();
      const mainPool = databaseManager.getPool('main');
      
      expect(defaultPool).toBe(mainPool);
    });

    test('should reject access to non-allowed databases', () => {
      expect(() => {
        databaseManager.getPool('unauthorized');
      }).toThrow("Database 'unauthorized' is not allowed or configured");
    });
  });

  describe('Database Routing Validation', () => {
    test('should validate database routing with priority order', () => {
      // GraphQL parameter > HTTP header > default
      expect(databaseManager.validateDatabaseRouting('analytics', 'audit')).toBe('analytics');
      expect(databaseManager.validateDatabaseRouting(null, 'audit')).toBe('audit');
      expect(databaseManager.validateDatabaseRouting()).toBe('main');
    });

    test('should provide helpful error messages with available databases', () => {
      expect(() => {
        databaseManager.validateDatabaseRouting('invalid');
      }).toThrow('Available databases: main, analytics, audit, archive');
    });

    test('should handle edge cases in routing validation', () => {
      expect(databaseManager.validateDatabaseRouting('', null)).toBe('main');
      expect(databaseManager.validateDatabaseRouting(undefined, undefined)).toBe('main');
    });
  });

  describe('Cross-Database Query Support', () => {
    test('should report cross-database query capability', () => {
      expect(databaseManager.isCrossDatabaseAllowed()).toBe(true);
    });

    test('should handle disabled cross-database queries', () => {
      // Mock configuration with cross-database queries disabled
      jest.doMock('../src/utils/config-loader.js', () => ({
        config: {
          DATABASE_ROUTING: {
            DEFAULT_DATABASE: 'main',
            ALLOWED_DATABASES: ['main'],
            ALLOW_CROSS_DATABASE_QUERIES: false
          },
          DATABASES: {
            main: {
              PATH: 'data/main.db',
              POOL: { MAX_CONNECTIONS: 5, ACQUIRE_TIMEOUT: 5000, CONNECTION_RETRY_DELAY: 1000, CONNECTION_RETRY_MAX: 3 }
            }
          }
        }
      }));

      const restrictedManager = new DatabaseManager();
      expect(restrictedManager.isCrossDatabaseAllowed()).toBe(false);
    });
  });

  describe('Database Statistics', () => {
    test('should provide statistics for all databases', () => {
      const stats = databaseManager.getStatistics();

      expect(stats.databases).toHaveProperty('main');
      expect(stats.databases).toHaveProperty('analytics');
      expect(stats.databases).toHaveProperty('audit');
      expect(stats.databases).toHaveProperty('archive');

      expect(stats.defaultDatabase).toBe('main');
      expect(stats.allowedDatabases).toEqual(['main', 'analytics', 'audit', 'archive']);
      expect(stats.allowCrossDatabase).toBe(true);

      // Check individual database statistics
      Object.values(stats.databases).forEach(dbStats => {
        expect(dbStats).toHaveProperty('available');
        expect(dbStats).toHaveProperty('using');
        expect(dbStats).toHaveProperty('waiting');
      });
    });

    test('should handle databases with different pool sizes', () => {
      const stats = databaseManager.getStatistics();

      // Main database should show 10 available connections
      expect(stats.databases.main.available).toBe(10);
      // Analytics should show 15
      expect(stats.databases.analytics.available).toBe(15);
      // Audit should show 5
      expect(stats.databases.audit.available).toBe(5);
      // Archive should show 3
      expect(stats.databases.archive.available).toBe(3);
    });
  });

  describe('Database Connection Management', () => {
    test('should close all database pools', async () => {
      const mainPool = databaseManager.getPool('main');
      const analyticsPool = databaseManager.getPool('analytics');
      
      await databaseManager.close();

      expect(mainPool.close).toHaveBeenCalled();
      expect(analyticsPool.close).toHaveBeenCalled();
      expect(databaseManager.pools.size).toBe(0);
    });

    test('should handle partial failures during close', async () => {
      const mainPool = databaseManager.getPool('main');
      const analyticsPool = databaseManager.getPool('analytics');
      
      mainPool.close.mockRejectedValue(new Error('Main close failed'));
      analyticsPool.close.mockResolvedValue();

      await expect(databaseManager.close()).rejects.toThrow('Main close failed');
    });
  });
});

describe('Multiple Database Support - Data Loaders', () => {
  let mockPool1, mockPool2;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockPool1 = {
      acquire: jest.fn().mockResolvedValue({ id: 'conn-db1' }),
      release: jest.fn().mockResolvedValue()
    };
    
    mockPool2 = {
      acquire: jest.fn().mockResolvedValue({ id: 'conn-db2' }),
      release: jest.fn().mockResolvedValue()
    };

    // Mock database manager to return different pools
    const mockDatabaseManager = {
      getPool: jest.fn((dbId) => {
        if (dbId === 'analytics') return mockPool2;
        return mockPool1; // default/main
      })
    };

    jest.doMock('../src/db/index.js', () => ({
      databaseManager: mockDatabaseManager
    }));
  });

  describe('Database-Specific Loaders', () => {
    test('should create loaders for specific databases', () => {
      const mainLoaders = createLoaders('main');
      const analyticsLoaders = createLoaders('analytics');

      expect(mainLoaders).toBeDefined();
      expect(analyticsLoaders).toBeDefined();
      expect(mainLoaders).not.toBe(analyticsLoaders);
    });

    test('should route queries to correct database', async () => {
      const baseLoader = new BaseQueryLoader({ databaseId: 'analytics' });
      
      const queryFn = jest.fn().mockResolvedValue('analytics result');
      await baseLoader.executeWithConnection(queryFn);

      expect(mockPool2.acquire).toHaveBeenCalled();
      expect(mockPool1.acquire).not.toHaveBeenCalled();
    });

    test('should handle default database routing', async () => {
      const baseLoader = new BaseQueryLoader(); // No database specified
      
      const queryFn = jest.fn().mockResolvedValue('main result');
      await baseLoader.executeWithConnection(queryFn);

      expect(mockPool1.acquire).toHaveBeenCalled();
      expect(mockPool2.acquire).not.toHaveBeenCalled();
    });
  });

  describe('Database-Specific Caching', () => {
    test('should generate different cache keys for different databases', async () => {
      const { withCache } = require('../src/utils/cache.js');
      withCache.mockImplementation(async (key, loader) => await loader());

      const mainLoader = new BaseQueryLoader({ databaseId: 'main', cachePrefix: 'test' });
      const analyticsLoader = new BaseQueryLoader({ databaseId: 'analytics', cachePrefix: 'test' });

      const loaderFn = jest.fn().mockResolvedValue('result');
      const key = 'same-key';

      await mainLoader.loadWithCache(key, loaderFn);
      await analyticsLoader.loadWithCache(key, loaderFn);

      expect(withCache).toHaveBeenCalledWith(
        'test:main:["same-key"]',
        expect.any(Function),
        expect.any(Number)
      );

      expect(withCache).toHaveBeenCalledWith(
        'test:analytics:["same-key"]',
        expect.any(Function),
        expect.any(Number)
      );
    });

    test('should isolate cache between databases', async () => {
      const { withCache } = require('../src/utils/cache.js');
      
      // Simulate cache hit for main, miss for analytics
      withCache.mockImplementation(async (key, loader) => {
        if (key.includes('main')) {
          return 'cached-main-result';
        }
        return await loader();
      });

      const mainLoader = new BaseQueryLoader({ databaseId: 'main' });
      const analyticsLoader = new BaseQueryLoader({ databaseId: 'analytics' });

      const loaderFn = jest.fn().mockResolvedValue('fresh-result');

      const mainResult = await mainLoader.loadWithCache('key', loaderFn);
      const analyticsResult = await analyticsLoader.loadWithCache('key', loaderFn);

      expect(mainResult).toBe('cached-main-result');
      expect(analyticsResult).toBe('fresh-result');
      expect(loaderFn).toHaveBeenCalledTimes(1); // Only called for analytics
    });
  });
});

describe('Multiple Database Support - Integration Scenarios', () => {
  test('should handle concurrent queries across multiple databases', async () => {
    const manager = new DatabaseManager();
    
    const operations = [
      () => manager.getPool('main').acquire(),
      () => manager.getPool('analytics').acquire(),
      () => manager.getPool('audit').acquire(),
      () => manager.getPool('archive').acquire()
    ];

    const connections = await Promise.all(operations.map(op => op()));

    expect(connections).toHaveLength(4);
    connections.forEach(conn => expect(conn).toBeDefined());
  });

  test('should handle database failover scenarios', async () => {
    const manager = new DatabaseManager();
    
    // Simulate one database failing
    const analyticsPool = manager.getPool('analytics');
    analyticsPool.acquire.mockRejectedValue(new Error('Analytics DB down'));

    // Main database should still work
    const mainPool = manager.getPool('main');
    await expect(mainPool.acquire()).resolves.toBeDefined();

    // Analytics should fail
    await expect(analyticsPool.acquire()).rejects.toThrow('Analytics DB down');
  });

  test('should handle dynamic database configuration changes', () => {
    const manager = new DatabaseManager();
    
    const initialDatabases = manager.getAvailableDatabases();
    expect(initialDatabases).toEqual(['main', 'analytics', 'audit', 'archive']);

    // Verify validation reflects current configuration
    expect(manager.validateDatabaseRouting('main')).toBe('main');
    expect(manager.validateDatabaseRouting('analytics')).toBe('analytics');
    
    expect(() => manager.validateDatabaseRouting('newdb')).toThrow();
  });

  test('should handle different database types and configurations', () => {
    // Verify each database has its unique configuration
    const manager = new DatabaseManager();
    const { DuckDBPool } = require('../src/db/pool.js');

    const calls = DuckDBPool.mock.calls;
    
    // Should have 4 different configurations
    expect(calls).toHaveLength(4);
    
    const configs = calls.map(call => call[0]);
    const maxConnections = configs.map(c => c.maxConnections);
    
    expect(maxConnections).toContain(10); // main
    expect(maxConnections).toContain(15); // analytics
    expect(maxConnections).toContain(5);  // audit
    expect(maxConnections).toContain(3);  // archive
  });

  test('should maintain database isolation in error scenarios', async () => {
    const manager = new DatabaseManager();
    
    const mainPool = manager.getPool('main');
    const analyticsPool = manager.getPool('analytics');

    // Simulate error in one database
    mainPool.acquire.mockRejectedValue(new Error('Main DB error'));
    
    // Other database should remain unaffected
    await expect(analyticsPool.acquire()).resolves.toBeDefined();
    
    // Stats should still show all databases
    const stats = manager.getStatistics();
    expect(Object.keys(stats.databases)).toEqual(['main', 'analytics', 'audit', 'archive']);
  });
});

describe('Multiple Database Support - Security and Validation', () => {
  test('should enforce database access restrictions', () => {
    const manager = new DatabaseManager();

    // Should allow access to configured databases
    expect(() => manager.getPool('main')).not.toThrow();
    expect(() => manager.getPool('analytics')).not.toThrow();

    // Should deny access to unconfigured databases
    expect(() => manager.getPool('secret')).toThrow();
    expect(() => manager.getPool('admin')).toThrow();
  });

  test('should validate database identifiers', () => {
    const manager = new DatabaseManager();

    expect(manager.isValidDatabase('main')).toBe(true);
    expect(manager.isValidDatabase('analytics')).toBe(true);
    expect(manager.isValidDatabase('invalid')).toBe(false);
    expect(manager.isValidDatabase('')).toBe(false);
    expect(manager.isValidDatabase(null)).toBe(false);
    expect(manager.isValidDatabase(undefined)).toBe(false);
  });

  test('should handle malicious database identifiers', () => {
    const manager = new DatabaseManager();

    const maliciousIds = [
      '../../../etc/passwd',
      'main; DROP TABLE users;',
      'main\'',
      'main"',
      '../../config',
      'C:\\Windows\\System32'
    ];

    maliciousIds.forEach(id => {
      expect(() => manager.getPool(id)).toThrow();
      expect(manager.isValidDatabase(id)).toBe(false);
    });
  });

  test('should prevent cross-database injection attacks', () => {
    const manager = new DatabaseManager();

    const attackVectors = [
      'main UNION SELECT * FROM other_db.secrets',
      'analytics; ATTACH DATABASE \'/tmp/malicious.db\' AS evil;',
      'audit\' OR 1=1--'
    ];

    attackVectors.forEach(attack => {
      expect(() => manager.validateDatabaseRouting(attack)).toThrow();
    });
  });
});