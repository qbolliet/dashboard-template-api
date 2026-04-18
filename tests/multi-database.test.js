// Unit tests for multi-catalog support - single shared DuckDB pool with multiple DuckLake catalogs
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
    CATALOGS: {
      main: {
        PATH: 'data/main.ducklake',
        DATA_PATH: 'data/main_data/',
        READ_ONLY: true
      },
      analytics: {
        PATH: 'data/analytics.ducklake',
        DATA_PATH: 'data/analytics_data/',
        READ_ONLY: true
      },
      audit: {
        PATH: 'data/audit.ducklake',
        DATA_PATH: 'data/audit_data/',
        READ_ONLY: true
      },
      archive: {
        PATH: 'data/archive.ducklake',
        DATA_PATH: 'data/archive_data/',
        READ_ONLY: true
      }
    },
    DATABASE: {
      POOL: {
        MAX_CONNECTIONS: 10,
        ACQUIRE_TIMEOUT: 5000,
        POOL_RETRY_DELAY: 100
      }
    },
    S3: { ENABLED: false },
    API: {
      LOADERS: {
        BATCH_SIZE: 10,
        DEFAULT_CACHE_TIMEOUT: 300,
        METADATA_CACHE_TIMEOUT: 600,
        DIMENSION_CACHE_TIMEOUT: 600,
        FACT_CACHE_TIMEOUT: 300,
        SELECT_OPTIONS_CACHE_TIMEOUT: 600,
        MAX_BATCH_SIZE: 100
      },
      PAGINATION: { MAX_LIMIT: 1000, MAX_OFFSET: 10000 }
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
  }),
  logger: { error: jest.fn() }
}));

// Mock DuckDBPool — returns a single shared pool
const sharedMockPool = {
  pool: [],
  catalogs: [
    { alias: 'main' },
    { alias: 'analytics' },
    { alias: 'audit' },
    { alias: 'archive' }
  ],
  maxConnections: 10,
  close: jest.fn().mockResolvedValue(),
  on: jest.fn(),
  acquire: jest.fn().mockResolvedValue({ id: 'test-connection' }),
  release: jest.fn().mockResolvedValue()
};

jest.mock('../src/db/pool.js', () => ({
  DuckDBPool: jest.fn().mockImplementation(() => sharedMockPool)
}));

jest.mock('../src/cache/index.js', () => ({
  redis: null
}));

jest.mock('../src/utils/cache.js', () => ({
  withCache: jest.fn().mockImplementation((key, loader) => loader())
}));

describe('Multi-Catalog Support - DatabaseManager', () => {
  let databaseManager;

  beforeEach(() => {
    jest.clearAllMocks();
    databaseManager = new DatabaseManager();
  });

  describe('Single Shared Pool Initialization', () => {
    test('should create exactly one shared pool for all catalogs', () => {
      const { DuckDBPool } = require('../src/db/pool.js');
      expect(DuckDBPool).toHaveBeenCalledTimes(1);
      expect(databaseManager.sharedPool).toBeDefined();
    });

    test('should attach all catalogs to the shared pool', () => {
      const { DuckDBPool } = require('../src/db/pool.js');
      expect(DuckDBPool).toHaveBeenCalledWith(expect.objectContaining({
        catalogs: expect.arrayContaining([
          expect.objectContaining({ alias: 'main' }),
          expect.objectContaining({ alias: 'analytics' }),
          expect.objectContaining({ alias: 'audit' }),
          expect.objectContaining({ alias: 'archive' })
        ])
      }));
    });

    test('should set correct database routing configuration', () => {
      expect(databaseManager.defaultDatabase).toBe('main');
      expect(databaseManager.allowedDatabases).toEqual(['main', 'analytics', 'audit', 'archive']);
      expect(databaseManager.allowCrossDatabase).toBe(true);
    });
  });

  describe('Catalog Pool Retrieval', () => {
    test('should return the shared pool for any valid catalog', () => {
      const mainPool = databaseManager.getPool('main');
      const analyticsPool = databaseManager.getPool('analytics');
      const auditPool = databaseManager.getPool('audit');
      const archivePool = databaseManager.getPool('archive');

      expect(mainPool).toBeDefined();
      expect(analyticsPool).toBeDefined();
      expect(auditPool).toBeDefined();
      expect(archivePool).toBeDefined();

      // All calls return the same shared pool instance
      expect(mainPool).toBe(analyticsPool);
      expect(analyticsPool).toBe(auditPool);
    });

    test('should return default catalog pool when no ID specified', () => {
      const defaultPool = databaseManager.getPool();
      const mainPool = databaseManager.getPool('main');

      expect(defaultPool).toBe(mainPool);
    });

    test('should reject access to non-allowed catalogs', () => {
      expect(() => {
        databaseManager.getPool('unauthorized');
      }).toThrow("Database 'unauthorized' is not allowed or not configured");
    });
  });

  describe('Database Routing Validation', () => {
    test('should validate database routing with priority order', () => {
      expect(databaseManager.validateDatabaseRouting('analytics', 'audit')).toBe('analytics');
      expect(databaseManager.validateDatabaseRouting(null, 'audit')).toBe('audit');
      expect(databaseManager.validateDatabaseRouting()).toBe('main');
    });

    test('should provide helpful error messages with available catalogs', () => {
      expect(() => {
        databaseManager.validateDatabaseRouting('invalid');
      }).toThrow('Available databases: main, analytics, audit, archive');
    });

    test('should handle edge cases in routing validation', () => {
      expect(databaseManager.validateDatabaseRouting('', null)).toBe('main');
      expect(databaseManager.validateDatabaseRouting(undefined, undefined)).toBe('main');
    });
  });

  describe('Cross-Catalog Query Support', () => {
    test('should report cross-catalog query capability', () => {
      expect(databaseManager.isCrossDatabaseAllowed()).toBe(true);
    });
  });

  describe('Database Statistics', () => {
    test('should provide statistics for the shared pool', () => {
      const stats = databaseManager.getStatistics();

      expect(stats.sharedPool).toBeDefined();
      expect(stats.defaultDatabase).toBe('main');
      expect(stats.allowedDatabases).toEqual(['main', 'analytics', 'audit', 'archive']);
      expect(stats.allowCrossDatabase).toBe(true);
    });

    test('should show attached catalogs in shared pool stats', () => {
      const stats = databaseManager.getStatistics();

      expect(stats.sharedPool.attachedCatalogs).toEqual(
        expect.arrayContaining(['main', 'analytics', 'audit', 'archive'])
      );
    });
  });

  describe('Database Connection Management', () => {
    test('should close the shared pool', async () => {
      await databaseManager.close();

      expect(sharedMockPool.close).toHaveBeenCalled();
      expect(databaseManager.sharedPool).toBeNull();
    });

    test('should handle errors during pool closure', async () => {
      sharedMockPool.close.mockRejectedValueOnce(new Error('Close failed'));

      await expect(databaseManager.close()).rejects.toThrow('Close failed');
    });
  });
});
