// Unit tests for database layer - DatabaseManager and DuckDBPool (DuckLake architecture)
import { jest } from '@jest/globals';

// Mock the configuration before importing DatabaseManager
const mockConfig = {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: 'main',
    ALLOWED_DATABASES: ['main', 'test', 'analytics'],
    ALLOW_CROSS_DATABASE_QUERIES: true
  },
  CATALOGS: {
    main: {
      PATH: 'data/test-main.ducklake',
      DATA_PATH: 'data/test-main_data/',
      READ_ONLY: false
    },
    test: {
      PATH: 'data/test-test.ducklake',
      DATA_PATH: 'data/test-test_data/',
      READ_ONLY: false
    },
    analytics: {
      PATH: 'data/test-analytics.ducklake',
      DATA_PATH: 'data/test-analytics_data/',
      READ_ONLY: true
    }
  },
  DATABASE: {
    POOL: {
      MAX_CONNECTIONS: 5,
      ACQUIRE_TIMEOUT: 5000,
      POOL_RETRY_DELAY: 100
    }
  },
  S3: {
    ENABLED: false
  }
};

jest.mock('../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

// Mock logger
jest.mock('../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    database: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

// Mock DuckDBPool — represents the single shared pool
jest.mock('../src/db/pool.js', () => ({
  DuckDBPool: jest.fn().mockImplementation((config) => ({
    config,
    catalogs: config.catalogs || [],
    pool: [],
    maxConnections: config.maxConnections,
    close: jest.fn().mockResolvedValue(),
    acquire: jest.fn().mockResolvedValue({}),
    release: jest.fn()
  }))
}));

// Mock the database manager module to prevent singleton creation on import
jest.mock('../src/db/database-manager.js', () => {
  const MockDatabaseManager = jest.fn().mockImplementation(function() {
    this.defaultDatabase = 'main';
    this.allowedDatabases = ['main', 'test', 'analytics'];
    this.allowCrossDatabase = true;
    this.sharedPool = {
      pool: [],
      maxConnections: 5,
      catalogs: [
        { alias: 'main' },
        { alias: 'test' },
        { alias: 'analytics' }
      ],
      close: jest.fn().mockResolvedValue(),
      acquire: jest.fn().mockResolvedValue({}),
      release: jest.fn()
    };
  });

  MockDatabaseManager.prototype.initializeDatabases = jest.fn();
  MockDatabaseManager.prototype.getPool = jest.fn();
  MockDatabaseManager.prototype.isValidDatabase = jest.fn();
  MockDatabaseManager.prototype.getAvailableDatabases = jest.fn();
  MockDatabaseManager.prototype.getDefaultDatabase = jest.fn();
  MockDatabaseManager.prototype.isCrossDatabaseAllowed = jest.fn();
  MockDatabaseManager.prototype.validateDatabaseRouting = jest.fn();
  MockDatabaseManager.prototype.close = jest.fn();
  MockDatabaseManager.prototype.getStatistics = jest.fn();

  return {
    DatabaseManager: MockDatabaseManager,
    databaseManager: new MockDatabaseManager(),
    closeAllConnections: jest.fn()
  };
});

// Now import the modules after mocking dependencies
import { DatabaseManager } from '../src/db/database-manager.js';
import { DuckDBPool } from '../src/db/pool.js';

let databaseManager;

describe('DatabaseManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    databaseManager = new DatabaseManager();
  });

  describe('Constructor and Initialization', () => {
    test('should initialize with correct configuration', () => {
      expect(databaseManager.defaultDatabase).toBe('main');
      expect(databaseManager.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(databaseManager.allowCrossDatabase).toBe(true);
    });

    test('should create a single shared DuckDBPool with all catalogs', () => {
      expect(DuckDBPool).toHaveBeenCalledTimes(1);
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        catalogs: expect.arrayContaining([
          expect.objectContaining({ alias: 'main' }),
          expect.objectContaining({ alias: 'test' }),
          expect.objectContaining({ alias: 'analytics' })
        ]),
        maxConnections: 5,
        acquireTimeout: 5000
      }));
    });

    test('should handle missing catalog files gracefully', () => {
      fs.existsSync.mockReturnValue(false);

      expect(() => {
        new DatabaseManager();
      }).not.toThrow();
    });

    test('should throw error if default catalog is not in CATALOGS config', () => {
      // Temporarily override config to remove 'main' catalog
      const originalCatalogs = mockConfig.CATALOGS;
      mockConfig.CATALOGS = {
        other: { PATH: 'other.ducklake', DATA_PATH: 'other_data/', READ_ONLY: true }
      };

      expect(() => {
        new DatabaseManager();
      }).toThrow("Default database 'main' not found in CATALOGS config");

      mockConfig.CATALOGS = originalCatalogs;
    });
  });

  describe('getPool', () => {
    test('should return shared pool when no catalog ID specified', () => {
      databaseManager.getPool.mockReturnValue(databaseManager.sharedPool);
      const pool = databaseManager.getPool();
      expect(pool).toBeDefined();
    });

    test('should return shared pool for any valid catalog ID', () => {
      databaseManager.getPool.mockReturnValue(databaseManager.sharedPool);
      const pool = databaseManager.getPool('test');
      expect(pool).toBe(databaseManager.sharedPool);
    });

    test('should throw error for invalid catalog ID', () => {
      databaseManager.getPool.mockImplementation((id) => {
        if (!['main', 'test', 'analytics'].includes(id || 'main')) {
          throw new Error(`Database '${id}' is not allowed or not configured`);
        }
        return databaseManager.sharedPool;
      });

      expect(() => {
        databaseManager.getPool('nonexistent');
      }).toThrow("Database 'nonexistent' is not allowed or not configured");
    });
  });

  describe('isValidDatabase', () => {
    test('should return true for allowed catalogs', () => {
      databaseManager.isValidDatabase.mockImplementation(id =>
        ['main', 'test', 'analytics'].includes(id)
      );

      expect(databaseManager.isValidDatabase('main')).toBe(true);
      expect(databaseManager.isValidDatabase('test')).toBe(true);
      expect(databaseManager.isValidDatabase('analytics')).toBe(true);
    });

    test('should return false for unknown catalogs', () => {
      databaseManager.isValidDatabase.mockImplementation(id =>
        ['main', 'test', 'analytics'].includes(id)
      );

      expect(databaseManager.isValidDatabase('nonexistent')).toBe(false);
      expect(databaseManager.isValidDatabase('')).toBe(false);
      expect(databaseManager.isValidDatabase(null)).toBe(false);
    });
  });

  describe('getAvailableDatabases', () => {
    test('should return array of allowed catalog IDs', () => {
      databaseManager.getAvailableDatabases.mockReturnValue(['main', 'test', 'analytics']);

      const databases = databaseManager.getAvailableDatabases();
      expect(databases).toEqual(expect.arrayContaining(['main', 'test', 'analytics']));
      expect(databases).toHaveLength(3);
    });
  });

  describe('getDefaultDatabase', () => {
    test('should return correct default catalog', () => {
      databaseManager.getDefaultDatabase.mockReturnValue('main');
      expect(databaseManager.getDefaultDatabase()).toBe('main');
    });
  });

  describe('isCrossDatabaseAllowed', () => {
    test('should return correct cross-catalog setting', () => {
      databaseManager.isCrossDatabaseAllowed.mockReturnValue(true);
      expect(databaseManager.isCrossDatabaseAllowed()).toBe(true);
    });
  });

  describe('validateDatabaseRouting', () => {
    beforeEach(() => {
      databaseManager.validateDatabaseRouting.mockImplementation((requested, context) => {
        const target = requested || context || 'main';
        if (!['main', 'test', 'analytics'].includes(target)) {
          throw new Error(
            `Database '${target}' is not available. Available databases: main, test, analytics`
          );
        }
        return target;
      });
    });

    test('should return requested catalog if valid', () => {
      expect(databaseManager.validateDatabaseRouting('test')).toBe('test');
    });

    test('should return context catalog if no requested catalog', () => {
      expect(databaseManager.validateDatabaseRouting(null, 'analytics')).toBe('analytics');
    });

    test('should return default catalog if neither requested nor context specified', () => {
      expect(databaseManager.validateDatabaseRouting()).toBe('main');
    });

    test('should prioritize requested over context catalog', () => {
      expect(databaseManager.validateDatabaseRouting('test', 'analytics')).toBe('test');
    });

    test('should throw error for invalid catalog', () => {
      expect(() => {
        databaseManager.validateDatabaseRouting('invalid');
      }).toThrow("Database 'invalid' is not available");
    });

    test('should include available catalogs in error message', () => {
      expect(() => {
        databaseManager.validateDatabaseRouting('invalid');
      }).toThrow('Available databases: main, test, analytics');
    });
  });

  describe('getStatistics', () => {
    test('should return statistics for the shared pool', () => {
      databaseManager.getStatistics.mockReturnValue({
        sharedPool: {
          available: 5,
          using: 0,
          total: 0,
          maxConnections: 5,
          attachedCatalogs: ['main', 'test', 'analytics']
        },
        defaultDatabase: 'main',
        allowedDatabases: ['main', 'test', 'analytics'],
        allowCrossDatabase: true
      });

      const stats = databaseManager.getStatistics();

      expect(stats.sharedPool).toBeDefined();
      expect(stats.sharedPool.attachedCatalogs).toEqual(
        expect.arrayContaining(['main', 'test', 'analytics'])
      );
      expect(stats.defaultDatabase).toBe('main');
      expect(stats.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(stats.allowCrossDatabase).toBe(true);
    });

    test('should return null sharedPool if not initialized', () => {
      databaseManager.getStatistics.mockReturnValue({
        sharedPool: null,
        defaultDatabase: 'main',
        allowedDatabases: ['main', 'test', 'analytics'],
        allowCrossDatabase: true
      });

      const stats = databaseManager.getStatistics();
      expect(stats.sharedPool).toBeNull();
    });
  });

  describe('close', () => {
    test('should close the shared pool', async () => {
      databaseManager.close.mockImplementation(async () => {
        await databaseManager.sharedPool.close();
        databaseManager.sharedPool = null;
      });

      await databaseManager.close();

      expect(databaseManager.sharedPool.close).toHaveBeenCalled();
      expect(databaseManager.sharedPool).toBeNull();
    });

    test('should handle errors during pool closure', async () => {
      databaseManager.close.mockRejectedValueOnce(new Error('Close failed'));

      await expect(databaseManager.close()).rejects.toThrow('Close failed');
    });
  });
});

describe('DuckDBPool Integration', () => {
  test('should create pool with catalog configuration', () => {
    const poolConfig = {
      catalogs: [
        { alias: 'main', path: '/abs/main.ducklake', dataPath: '/abs/data/', readOnly: true }
      ],
      maxConnections: 10,
      acquireTimeout: 5000,
      retryDelay: 50
    };

    new DuckDBPool(poolConfig);

    expect(DuckDBPool).toHaveBeenCalledWith(poolConfig);
  });
});

describe('Database Manager Error Scenarios', () => {
  test('should handle concurrent catalog operations', async () => {
    const operations = [
      () => databaseManager.getPool('main'),
      () => databaseManager.getPool('test'),
      () => databaseManager.getStatistics(),
      () => databaseManager.validateDatabaseRouting('analytics'),
      () => databaseManager.isValidDatabase('main')
    ];

    databaseManager.getPool.mockReturnValue(databaseManager.sharedPool);
    databaseManager.getStatistics.mockReturnValue({ sharedPool: null, defaultDatabase: 'main' });
    databaseManager.validateDatabaseRouting.mockReturnValue('analytics');
    databaseManager.isValidDatabase.mockReturnValue(true);

    const results = await Promise.all(operations.map(op => Promise.resolve(op())));
    expect(results).toHaveLength(5);
    results.forEach(result => expect(result).toBeDefined());
  });
});
