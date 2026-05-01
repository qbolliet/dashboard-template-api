// Unit tests for DatabaseManager using dependency injection
import { jest } from '@jest/globals';
import fs from 'fs';
import { InjectableDatabaseManager } from './utils/database-manager-injectable.js';
import { createTestContainer } from './utils/di-container.js';
import { testConfig } from './test-config-loader.js';

// Mock external dependencies
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  statSync: jest.fn().mockReturnValue({
    size: 1024000,
    mtime: new Date('2023-01-01')
  })
}));

jest.mock('../src/db/pool.js', () => ({
  DuckDBPool: jest.fn().mockImplementation((config) => ({
    config,
    close: jest.fn().mockResolvedValue(),
    on: jest.fn(),
    available: config.maxConnections,
    using: 0,
    waiting: 0,
    acquire: jest.fn().mockResolvedValue({ id: 'test-connection' }),
    release: jest.fn().mockResolvedValue()
  }))
}));

import { DuckDBPool } from '../src/db/pool.js';

describe('Injectable DatabaseManager', () => {
  let container;
  let mockLogger;
  let mockConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    
    container = createTestContainer();
    
    mockLogger = {
      database: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn()
    };

    mockConfig = {
      DATABASE_ROUTING: {
        DEFAULT_DATABASE: 'main',
        ALLOWED_DATABASES: ['main', 'test', 'analytics'],
        ALLOW_CROSS_DATABASE_QUERIES: true
      },
      DATABASES: {
        main: {
          PATH: 'test-data/main.db',
          POOL: {
            MAX_CONNECTIONS: 5,
            ACQUIRE_TIMEOUT: 5000,
            CONNECTION_RETRY_DELAY: 1000,
            CONNECTION_RETRY_MAX: 3
          }
        },
        test: {
          PATH: 'test-data/test.db',
          POOL: {
            MAX_CONNECTIONS: 3,
            ACQUIRE_TIMEOUT: 3000,
            CONNECTION_RETRY_DELAY: 500,
            CONNECTION_RETRY_MAX: 2
          }
        },
        analytics: {
          PATH: 'test-data/analytics.db',
          POOL: {
            MAX_CONNECTIONS: 10,
            ACQUIRE_TIMEOUT: 10000,
            CONNECTION_RETRY_DELAY: 2000,
            CONNECTION_RETRY_MAX: 5
          }
        }
      }
    };
  });

  describe('Constructor and Initialization', () => {
    test('should initialize with correct configuration', () => {
      const databaseManager = new InjectableDatabaseManager(mockConfig, mockLogger);
      
      expect(databaseManager.defaultDatabase).toBe('main');
      expect(databaseManager.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(databaseManager.allowCrossDatabase).toBe(true);
      expect(databaseManager.pools.size).toBe(3);
    });

    test('should throw error without required configuration', () => {
      expect(() => {
        new InjectableDatabaseManager({}, mockLogger);
      }).toThrow('DATABASE_ROUTING configuration is required');
    });

    test('should create null logger when none provided', () => {
      const databaseManager = new InjectableDatabaseManager(mockConfig);
      
      expect(databaseManager.logger).toBeDefined();
      // Should not throw when calling logger methods
      expect(() => databaseManager.logger.database('test')).not.toThrow();
    });

    test('should skip auto-initialization when disabled', () => {
      const configWithoutAutoInit = {
        ...mockConfig,
        DATABASE_ROUTING: {
          ...mockConfig.DATABASE_ROUTING,
          AUTO_INITIALIZE: false
        }
      };

      const databaseManager = new InjectableDatabaseManager(configWithoutAutoInit, mockLogger);
      
      expect(databaseManager.pools.size).toBe(0);
    });
  });

  describe('Database Pool Management', () => {
    let databaseManager;

    beforeEach(() => {
      databaseManager = new InjectableDatabaseManager(mockConfig, mockLogger);
    });

    test('should return correct pool for each database', () => {
      const mainPool = databaseManager.getPool('main');
      const testPool = databaseManager.getPool('test');
      const analyticsPool = databaseManager.getPool('analytics');

      expect(mainPool).toBeDefined();
      expect(testPool).toBeDefined();
      expect(analyticsPool).toBeDefined();
      
      // Should be different instances
      expect(mainPool).not.toBe(testPool);
      expect(testPool).not.toBe(analyticsPool);
    });

    test('should return default database pool when no ID specified', () => {
      const defaultPool = databaseManager.getPool();
      const mainPool = databaseManager.getPool('main');
      
      expect(defaultPool).toBe(mainPool);
    });

    test('should throw error for invalid database', () => {
      expect(() => {
        databaseManager.getPool('nonexistent');
      }).toThrow("Database 'nonexistent' is not allowed or configured");
    });
  });

  describe('Database Validation', () => {
    let databaseManager;

    beforeEach(() => {
      databaseManager = new InjectableDatabaseManager(mockConfig, mockLogger);
    });

    test('should validate database IDs correctly', () => {
      expect(databaseManager.isValidDatabase('main')).toBe(true);
      expect(databaseManager.isValidDatabase('test')).toBe(true);
      expect(databaseManager.isValidDatabase('analytics')).toBe(true);
      expect(databaseManager.isValidDatabase('invalid')).toBe(false);
      expect(databaseManager.isValidDatabase('')).toBe(false);
      expect(databaseManager.isValidDatabase(null)).toBe(false);
    });

    test('should validate database routing with priority', () => {
      expect(databaseManager.validateDatabaseRouting('analytics', 'test')).toBe('analytics');
      expect(databaseManager.validateDatabaseRouting(null, 'test')).toBe('test');
      expect(databaseManager.validateDatabaseRouting()).toBe('main');
    });

    test('should provide helpful error messages for invalid routing', () => {
      expect(() => {
        databaseManager.validateDatabaseRouting('invalid');
      }).toThrow('Available databases: main, test, analytics');
    });
  });

  describe('Database Statistics', () => {
    let databaseManager;

    beforeEach(() => {
      databaseManager = new InjectableDatabaseManager(mockConfig, mockLogger);
    });

    test('should return comprehensive statistics', () => {
      const stats = databaseManager.getStatistics();

      expect(stats.databases).toHaveProperty('main');
      expect(stats.databases).toHaveProperty('test');
      expect(stats.databases).toHaveProperty('analytics');
      
      expect(stats.defaultDatabase).toBe('main');
      expect(stats.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(stats.allowCrossDatabase).toBe(true);

      // Check pool statistics
      expect(stats.databases.main.available).toBe(5);
      expect(stats.databases.test.available).toBe(3);
      expect(stats.databases.analytics.available).toBe(10);
    });
  });

  describe('Database Operations', () => {
    let databaseManager;

    beforeEach(() => {
      databaseManager = new InjectableDatabaseManager(mockConfig, mockLogger);
    });

    test('should close all database pools', async () => {
      const mainPool = databaseManager.getPool('main');
      const testPool = databaseManager.getPool('test');

      await databaseManager.close();

      expect(mainPool.close).toHaveBeenCalled();
      expect(testPool.close).toHaveBeenCalled();
      expect(databaseManager.pools.size).toBe(0);
    });

    test('should handle errors during close gracefully', async () => {
      const mainPool = databaseManager.getPool('main');
      mainPool.close.mockRejectedValueOnce(new Error('Close failed'));

      await expect(databaseManager.close()).rejects.toThrow('Close failed');
    });

    test('should provide utility methods', () => {
      expect(databaseManager.getAvailableDatabases()).toEqual(['main', 'test', 'analytics']);
      expect(databaseManager.getDefaultDatabase()).toBe('main');
      expect(databaseManager.isCrossDatabaseAllowed()).toBe(true);
    });
  });

  describe('Multiple Database Scenarios', () => {
    test('should handle different pool configurations', () => {
      const databaseManager = new InjectableDatabaseManager(mockConfig, mockLogger);

      // Verify each database was initialized with correct configuration
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        maxConnections: 5
      })); // main
      
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        maxConnections: 3
      })); // test
      
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        maxConnections: 10
      })); // analytics
    });

    test('should handle partial initialization failures', () => {
      // Mock one database to fail
      DuckDBPool.mockImplementationOnce(() => {
        throw new Error('Database initialization failed');
      }).mockImplementation((config) => ({
        config,
        close: jest.fn(),
        on: jest.fn(),
        available: config.maxConnections,
        using: 0,
        waiting: 0
      }));

      expect(() => {
        new InjectableDatabaseManager(mockConfig, mockLogger);
      }).toThrow("Default database 'main' failed to initialize");
    });
  });

  describe('Dependency Injection Integration', () => {
    test('should work with DI container', () => {
      // Register dependencies in container
      container.instance('config', mockConfig);
      container.instance('logger', mockLogger);
      
      // Register database manager factory
      container.register('databaseManager', (config, logger) => {
        return new InjectableDatabaseManager(config, logger);
      }, { dependencies: ['config', 'logger'] });

      // Get instance from container
      const databaseManager = container.get('databaseManager');
      
      expect(databaseManager).toBeInstanceOf(InjectableDatabaseManager);
      expect(databaseManager.defaultDatabase).toBe('main');
    });

    test('should support mocking in DI container', () => {
      const mockDatabaseManager = {
        getPool: jest.fn().mockReturnValue({ acquire: jest.fn() }),
        isValidDatabase: jest.fn().mockReturnValue(true)
      };

      container.mock('databaseManager', mockDatabaseManager);
      
      const instance = container.get('databaseManager');
      expect(instance).toBe(mockDatabaseManager);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle missing database files gracefully', () => {
      fs.existsSync.mockReturnValue(false);

      expect(() => {
        new InjectableDatabaseManager(mockConfig, mockLogger);
      }).not.toThrow();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Database file not found'),
        expect.any(Object)
      );
    });

    test('should handle malformed configuration', () => {
      const invalidConfig = {
        DATABASE_ROUTING: {
          DEFAULT_DATABASE: 'main',
          ALLOWED_DATABASES: ['main'],
          ALLOW_CROSS_DATABASE_QUERIES: true
        },
        DATABASES: {} // Empty databases
      };

      expect(() => {
        new InjectableDatabaseManager(invalidConfig, mockLogger);
      }).toThrow("Default database 'main' failed to initialize");
    });

    test('should handle concurrent operations', async () => {
      const databaseManager = new InjectableDatabaseManager(mockConfig, mockLogger);
      
      const operations = [
        () => databaseManager.getPool('main'),
        () => databaseManager.getPool('test'),
        () => databaseManager.getStatistics(),
        () => databaseManager.validateDatabaseRouting('analytics')
      ];

      const results = await Promise.all(operations.map(op => Promise.resolve(op())));
      
      expect(results).toHaveLength(4);
      results.forEach(result => expect(result).toBeDefined());
    });
  });
});