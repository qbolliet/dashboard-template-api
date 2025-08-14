// Unit tests for database layer - DatabaseManager and DuckDBPool
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// Mock external dependencies first, before any imports
jest.mock('fs');

// Mock the configuration before importing DatabaseManager
const mockConfig = {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: 'main',
    ALLOWED_DATABASES: ['main', 'test', 'analytics'],
    ALLOW_CROSS_DATABASE_QUERIES: true
  },
  DATABASES: {
    main: {
      PATH: 'data/main.db',
      POOL: {
        MAX_CONNECTIONS: 5,
        ACQUIRE_TIMEOUT: 5000,
        CONNECTION_RETRY_DELAY: 1000,
        CONNECTION_RETRY_MAX: 3
      }
    },
    test: {
      PATH: 'data/test.db',
      POOL: {
        MAX_CONNECTIONS: 3,
        ACQUIRE_TIMEOUT: 3000,
        CONNECTION_RETRY_DELAY: 500,
        CONNECTION_RETRY_MAX: 2
      }
    },
    analytics: {
      PATH: 'data/analytics.db',
      POOL: {
        MAX_CONNECTIONS: 10,
        ACQUIRE_TIMEOUT: 10000,
        CONNECTION_RETRY_DELAY: 2000,
        CONNECTION_RETRY_MAX: 5
      }
    }
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

// Mock DuckDBPool
jest.mock('../src/db/pool.js', () => ({
  DuckDBPool: jest.fn().mockImplementation((config) => ({
    config,
    close: jest.fn().mockResolvedValue(),
    on: jest.fn(),
    available: 5,
    using: 0,
    waiting: 0,
    acquire: jest.fn().mockResolvedValue({}),
    release: jest.fn().mockResolvedValue()
  }))
}));

// Mock the database manager module to prevent singleton creation
jest.mock('../src/db/database-manager.js', () => {
  const MockDatabaseManager = jest.fn().mockImplementation(function() {
    this.pools = new Map();
    this.defaultDatabase = 'main';
    this.allowedDatabases = ['main', 'test', 'analytics'];
    this.allowCrossDatabase = true;
    
    // Initialize pools with mocked versions
    const mockPools = ['main', 'test', 'analytics'];
    mockPools.forEach(dbId => {
      this.pools.set(dbId, {
        config: {},
        close: jest.fn().mockResolvedValue(),
        on: jest.fn(),
        available: 5,
        using: 0,
        waiting: 0,
        acquire: jest.fn().mockResolvedValue({}),
        release: jest.fn().mockResolvedValue()
      });
    });
  });
  
  MockDatabaseManager.prototype.initializeDatabases = jest.fn();
  MockDatabaseManager.prototype.initializeDatabase = jest.fn();
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
import { DatabaseManager, DuckDBPool } from '../src/db/index.js';

describe('DatabaseManager', () => {
  let databaseManager;
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock fs.existsSync to return true for all database files
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({
      size: 1024000,
      mtime: new Date('2023-01-01')
    });
    
    // Create new instance for each test
    databaseManager = new DatabaseManager();
  });

  describe('Constructor and Initialization', () => {
    test('should initialize with correct configuration', () => {
      expect(databaseManager.defaultDatabase).toBe('main');
      expect(databaseManager.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(databaseManager.allowCrossDatabase).toBe(true);
    });

    test('should create pools for all configured databases', () => {
      expect(DuckDBPool).toHaveBeenCalledTimes(3);
      expect(databaseManager.pools.size).toBe(3);
      expect(databaseManager.pools.has('main')).toBe(true);
      expect(databaseManager.pools.has('test')).toBe(true);
      expect(databaseManager.pools.has('analytics')).toBe(true);
    });

    test('should handle missing database files gracefully', () => {
      fs.existsSync.mockReturnValue(false);
      
      expect(() => {
        new DatabaseManager();
      }).not.toThrow();
    });

    test('should throw error if default database fails to initialize', () => {
      // Mock DuckDBPool to throw error for main database
      DuckDBPool.mockImplementationOnce((config) => {
        if (config.path.includes('main.db')) {
          throw new Error('Failed to initialize main database');
        }
        return {
          config,
          close: jest.fn().mockResolvedValue(),
          on: jest.fn(),
          available: 5,
          using: 0,
          waiting: 0
        };
      });

      expect(() => {
        new DatabaseManager();
      }).toThrow("Default database 'main' failed to initialize");
    });
  });

  describe('initializeDatabase', () => {
    test('should initialize database with correct configuration', () => {
      const dbConfig = {
        PATH: 'data/custom.db',
        POOL: {
          MAX_CONNECTIONS: 7,
          ACQUIRE_TIMEOUT: 6000,
          CONNECTION_RETRY_DELAY: 1500,
          CONNECTION_RETRY_MAX: 4
        }
      };

      databaseManager.initializeDatabase('custom', dbConfig);

      expect(DuckDBPool).toHaveBeenLastCalledWith(expect.objectContaining({
        maxConnections: 7,
        acquireTimeout: 6000,
        retryDelay: 1500,
        maxRetries: 4
      }));
    });

    test('should resolve database path correctly', () => {
      const dbConfig = {
        PATH: 'relative/path/db.db',
        POOL: {
          MAX_CONNECTIONS: 5,
          ACQUIRE_TIMEOUT: 5000,
          CONNECTION_RETRY_DELAY: 1000,
          CONNECTION_RETRY_MAX: 3
        }
      };

      databaseManager.initializeDatabase('custom', dbConfig);

      const expectedPath = path.resolve(process.cwd(), 'src', 'db', '../../', 'relative/path/db.db');
      expect(DuckDBPool).toHaveBeenLastCalledWith(expect.objectContaining({
        path: expect.stringContaining('relative/path/db.db')
      }));
    });
  });

  describe('getPool', () => {
    test('should return default database pool when no ID specified', () => {
      const pool = databaseManager.getPool();
      expect(pool).toBeDefined();
    });

    test('should return specific database pool when ID specified', () => {
      const pool = databaseManager.getPool('test');
      expect(pool).toBeDefined();
    });

    test('should throw error for invalid database ID', () => {
      expect(() => {
        databaseManager.getPool('nonexistent');
      }).toThrow("Database 'nonexistent' is not allowed or configured");
    });

    test('should throw error for unconfigured but allowed database', () => {
      // Remove a pool but keep it in allowed databases
      databaseManager.pools.delete('test');
      
      expect(() => {
        databaseManager.getPool('test');
      }).toThrow("Database pool for 'test' not found");
    });
  });

  describe('isValidDatabase', () => {
    test('should return true for valid database', () => {
      expect(databaseManager.isValidDatabase('main')).toBe(true);
      expect(databaseManager.isValidDatabase('test')).toBe(true);
      expect(databaseManager.isValidDatabase('analytics')).toBe(true);
    });

    test('should return false for invalid database', () => {
      expect(databaseManager.isValidDatabase('nonexistent')).toBe(false);
      expect(databaseManager.isValidDatabase('')).toBe(false);
      expect(databaseManager.isValidDatabase(null)).toBe(false);
    });

    test('should return false for unconfigured database', () => {
      databaseManager.pools.delete('test');
      expect(databaseManager.isValidDatabase('test')).toBe(false);
    });
  });

  describe('getAvailableDatabases', () => {
    test('should return array of available database IDs', () => {
      const databases = databaseManager.getAvailableDatabases();
      expect(databases).toEqual(expect.arrayContaining(['main', 'test', 'analytics']));
      expect(databases).toHaveLength(3);
    });

    test('should return empty array if no databases configured', () => {
      databaseManager.pools.clear();
      expect(databaseManager.getAvailableDatabases()).toEqual([]);
    });
  });

  describe('getDefaultDatabase', () => {
    test('should return correct default database', () => {
      expect(databaseManager.getDefaultDatabase()).toBe('main');
    });
  });

  describe('isCrossDatabaseAllowed', () => {
    test('should return correct cross-database setting', () => {
      expect(databaseManager.isCrossDatabaseAllowed()).toBe(true);
    });
  });

  describe('validateDatabaseRouting', () => {
    test('should return requested database if valid', () => {
      const result = databaseManager.validateDatabaseRouting('test');
      expect(result).toBe('test');
    });

    test('should return context database if no requested database', () => {
      const result = databaseManager.validateDatabaseRouting(null, 'analytics');
      expect(result).toBe('analytics');
    });

    test('should return default database if neither requested nor context specified', () => {
      const result = databaseManager.validateDatabaseRouting();
      expect(result).toBe('main');
    });

    test('should prioritize requested over context database', () => {
      const result = databaseManager.validateDatabaseRouting('test', 'analytics');
      expect(result).toBe('test');
    });

    test('should throw error for invalid database', () => {
      expect(() => {
        databaseManager.validateDatabaseRouting('invalid');
      }).toThrow("Database 'invalid' is not available");
    });

    test('should include available databases in error message', () => {
      expect(() => {
        databaseManager.validateDatabaseRouting('invalid');
      }).toThrow('Available databases: main, test, analytics');
    });
  });

  describe('getStatistics', () => {
    test('should return statistics for all databases', () => {
      const stats = databaseManager.getStatistics();
      
      expect(stats).toEqual({
        databases: {
          main: { available: 5, using: 0, waiting: 0 },
          test: { available: 5, using: 0, waiting: 0 },
          analytics: { available: 5, using: 0, waiting: 0 }
        },
        defaultDatabase: 'main',
        allowedDatabases: ['main', 'test', 'analytics'],
        allowCrossDatabase: true
      });
    });

    test('should handle pools without statistics gracefully', () => {
      // Mock a pool without statistics
      const mockPool = {
        close: jest.fn().mockResolvedValue(),
        on: jest.fn()
      };
      databaseManager.pools.set('nostats', mockPool);
      
      const stats = databaseManager.getStatistics();
      expect(stats.databases.nostats).toEqual({
        available: 0,
        using: 0,
        waiting: 0
      });
    });
  });

  describe('close', () => {
    test('should close all database pools', async () => {
      const mainPool = databaseManager.pools.get('main');
      const testPool = databaseManager.pools.get('test');
      const analyticsPool = databaseManager.pools.get('analytics');

      await databaseManager.close();

      expect(mainPool.close).toHaveBeenCalled();
      expect(testPool.close).toHaveBeenCalled();
      expect(analyticsPool.close).toHaveBeenCalled();
      expect(databaseManager.pools.size).toBe(0);
    });

    test('should handle errors during pool closure', async () => {
      const mockPool = databaseManager.pools.get('main');
      mockPool.close.mockRejectedValueOnce(new Error('Close failed'));

      await expect(databaseManager.close()).rejects.toThrow('Close failed');
    });

    test('should clear pools map after closing', async () => {
      await databaseManager.close();
      expect(databaseManager.pools.size).toBe(0);
    });
  });
});

describe('DuckDBPool Integration', () => {
  test('should create pool with correct configuration', () => {
    const config = {
      path: '/path/to/database.db',
      maxConnections: 10,
      acquireTimeout: 5000,
      retryDelay: 1000,
      maxRetries: 3
    };

    new DuckDBPool(config);

    expect(DuckDBPool).toHaveBeenCalledWith(config);
  });
});

describe('Database Manager Error Scenarios', () => {
  test('should handle database initialization errors gracefully', () => {
    // Mock config with invalid database
    jest.doMock('../src/utils/config-loader.js', () => ({
      config: {
        DATABASE_ROUTING: {
          DEFAULT_DATABASE: 'main',
          ALLOWED_DATABASES: ['main'],
          ALLOW_CROSS_DATABASE_QUERIES: false
        },
        DATABASES: {
          main: {
            PATH: '/invalid/path/main.db',
            POOL: {
              MAX_CONNECTIONS: 5,
              ACQUIRE_TIMEOUT: 5000,
              CONNECTION_RETRY_DELAY: 1000,
              CONNECTION_RETRY_MAX: 3
            }
          }
        }
      }
    }));

    // Should not throw during non-critical database initialization
    expect(() => {
      new DatabaseManager();
    }).not.toThrow();
  });

  test('should handle concurrent database operations', async () => {
    const operations = [
      () => databaseManager.getPool('main'),
      () => databaseManager.getPool('test'),
      () => databaseManager.getStatistics(),
      () => databaseManager.validateDatabaseRouting('analytics'),
      () => databaseManager.isValidDatabase('main')
    ];

    // All operations should complete without errors
    const results = await Promise.all(operations.map(op => Promise.resolve(op())));
    expect(results).toHaveLength(5);
    results.forEach(result => expect(result).toBeDefined());
  });
});