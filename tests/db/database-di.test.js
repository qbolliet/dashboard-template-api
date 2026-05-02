// Unit tests for InjectableDatabaseManager (tests/database-manager-injectable.js)
// Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
import { jest } from '@jest/globals';

// ─── Shared mock state ────────────────────────────────────────────────────────

const fsExists = jest.fn().mockReturnValue(true);
const fsStat   = jest.fn().mockReturnValue({ size: 1024000, mtime: new Date('2023-01-01') });

const makeMockPool = (cfg = {}) => ({
  config:    cfg,
  available: cfg.maxConnections ?? 5,
  using:     0,
  waiting:   0,
  close:     jest.fn().mockResolvedValue(undefined),
  on:        jest.fn(),
  acquire:   jest.fn().mockResolvedValue({ id: 'test-conn' }),
  release:   jest.fn()
});

const MockDuckDBPool = jest.fn().mockImplementation(cfg => makeMockPool(cfg));

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../src/db/pool.js', () => ({ DuckDBPool: MockDuckDBPool }));
jest.unstable_mockModule('fs', () => ({
  default:    { existsSync: fsExists, statSync: fsStat },
  existsSync: fsExists,
  statSync:   fsStat
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let InjectableDatabaseManager;
let createTestContainer;
let DuckDBPool;

beforeAll(async () => {
  ({ InjectableDatabaseManager } = await import('../database-manager-injectable.js'));
  ({ createTestContainer }       = await import('../di-container.js'));
  ({ DuckDBPool }                = await import('../../src/db/pool.js'));
});

// ─── Config factory ───────────────────────────────────────────────────────────

const makeConfig = () => ({
  DATABASE_ROUTING: {
    DEFAULT_DATABASE:            'main',
    ALLOWED_DATABASES:           ['main', 'test', 'analytics'],
    ALLOW_CROSS_DATABASE_QUERIES: true
  },
  DATABASES: {
    main: {
      PATH: 'test-data/main.db',
      POOL: { MAX_CONNECTIONS: 5,  ACQUIRE_TIMEOUT: 5000,  CONNECTION_RETRY_DELAY: 1000, CONNECTION_RETRY_MAX: 3 }
    },
    test: {
      PATH: 'test-data/test.db',
      POOL: { MAX_CONNECTIONS: 3,  ACQUIRE_TIMEOUT: 3000,  CONNECTION_RETRY_DELAY: 500,  CONNECTION_RETRY_MAX: 2 }
    },
    analytics: {
      PATH: 'test-data/analytics.db',
      POOL: { MAX_CONNECTIONS: 10, ACQUIRE_TIMEOUT: 10000, CONNECTION_RETRY_DELAY: 2000, CONNECTION_RETRY_MAX: 5 }
    }
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Injectable DatabaseManager', () => {
  let mockConfig;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    MockDuckDBPool.mockImplementation(cfg => makeMockPool(cfg));
    fsExists.mockReturnValue(true);
    fsStat.mockReturnValue({ size: 1024000, mtime: new Date('2023-01-01') });
    mockConfig = makeConfig();
    mockLogger = { database: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  });

  // ── Constructor & initialization ──────────────────────────────────────────

  describe('Constructor and Initialization', () => {
    test('should initialize with correct configuration', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(dm.defaultDatabase).toBe('main');
      expect(dm.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(dm.allowCrossDatabase).toBe(true);
      expect(dm.pools.size).toBe(3);
    });

    test('should throw error without required configuration', () => {
      expect(() => new InjectableDatabaseManager({}, mockLogger))
        .toThrow('DATABASE_ROUTING configuration is required');
    });

    test('should create null logger when none provided', () => {
      const dm = new InjectableDatabaseManager(mockConfig);
      expect(dm.logger).toBeDefined();
      expect(() => dm.logger.database('test')).not.toThrow();
    });

    test('should skip auto-initialization when disabled', () => {
      mockConfig.DATABASE_ROUTING.AUTO_INITIALIZE = false;
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(dm.pools.size).toBe(0);
    });
  });

  // ── Pool management ───────────────────────────────────────────────────────

  describe('Database Pool Management', () => {
    test('should return distinct pool for each database', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      const mainPool      = dm.getPool('main');
      const testPool      = dm.getPool('test');
      const analyticsPool = dm.getPool('analytics');

      expect(mainPool).toBeDefined();
      expect(testPool).toBeDefined();
      expect(analyticsPool).toBeDefined();
      expect(mainPool).not.toBe(testPool);
      expect(testPool).not.toBe(analyticsPool);
    });

    test('should return default pool when no ID specified', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(dm.getPool()).toBe(dm.getPool('main'));
    });

    test('should throw error for invalid database', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(() => dm.getPool('nonexistent'))
        .toThrow("Database 'nonexistent' is not allowed or configured");
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe('Database Validation', () => {
    test('should validate database IDs correctly', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(dm.isValidDatabase('main')).toBe(true);
      expect(dm.isValidDatabase('test')).toBe(true);
      expect(dm.isValidDatabase('analytics')).toBe(true);
      expect(dm.isValidDatabase('invalid')).toBe(false);
      expect(dm.isValidDatabase('')).toBe(false);
      expect(dm.isValidDatabase(null)).toBe(false);
    });

    test('should validate routing with correct priority', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(dm.validateDatabaseRouting('analytics', 'test')).toBe('analytics');
      expect(dm.validateDatabaseRouting(null, 'test')).toBe('test');
      expect(dm.validateDatabaseRouting()).toBe('main');
    });

    test('should include available databases in routing error message', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(() => dm.validateDatabaseRouting('invalid'))
        .toThrow('Available databases:');
    });
  });

  // ── Statistics ────────────────────────────────────────────────────────────

  describe('Database Statistics', () => {
    test('should return stats for every database', () => {
      const dm    = new InjectableDatabaseManager(mockConfig, mockLogger);
      const stats = dm.getStatistics();

      expect(stats.databases).toHaveProperty('main');
      expect(stats.databases).toHaveProperty('test');
      expect(stats.databases).toHaveProperty('analytics');
      expect(stats.defaultDatabase).toBe('main');
      expect(stats.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(stats.allowCrossDatabase).toBe(true);
    });

    test('pool stats reflect MAX_CONNECTIONS from config', () => {
      const dm    = new InjectableDatabaseManager(mockConfig, mockLogger);
      const stats = dm.getStatistics();
      expect(stats.databases.main.available).toBe(5);
      expect(stats.databases.test.available).toBe(3);
      expect(stats.databases.analytics.available).toBe(10);
    });
  });

  // ── Close ─────────────────────────────────────────────────────────────────

  describe('Database Operations', () => {
    test('should close all database pools', async () => {
      const dm       = new InjectableDatabaseManager(mockConfig, mockLogger);
      const mainPool = dm.getPool('main');
      const testPool = dm.getPool('test');

      await dm.close();

      expect(mainPool.close).toHaveBeenCalled();
      expect(testPool.close).toHaveBeenCalled();
      expect(dm.pools.size).toBe(0);
    });

    test('should propagate errors during close', async () => {
      const dm       = new InjectableDatabaseManager(mockConfig, mockLogger);
      const mainPool = dm.getPool('main');
      mainPool.close.mockRejectedValueOnce(new Error('Close failed'));

      await expect(dm.close()).rejects.toThrow('Close failed');
    });

    test('should provide correct utility method results', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(dm.getAvailableDatabases()).toEqual(['main', 'test', 'analytics']);
      expect(dm.getDefaultDatabase()).toBe('main');
      expect(dm.isCrossDatabaseAllowed()).toBe(true);
    });
  });

  // ── Pool config per database ──────────────────────────────────────────────

  describe('Multiple Database Scenarios', () => {
    test('should initialize each database with its specific maxConnections', () => {
      new InjectableDatabaseManager(mockConfig, mockLogger);
      const maxConns = MockDuckDBPool.mock.calls.map(c => c[0].maxConnections);
      expect(maxConns).toContain(5);
      expect(maxConns).toContain(3);
      expect(maxConns).toContain(10);
    });

    test('should throw when default database fails to initialize', () => {
      MockDuckDBPool
        .mockImplementationOnce(() => { throw new Error('Pool init failed'); })
        .mockImplementation(makeMockPool);

      expect(() => new InjectableDatabaseManager(mockConfig, mockLogger))
        .toThrow("Default database 'main' failed to initialize");
    });
  });

  // ── DI container integration ──────────────────────────────────────────────

  describe('Dependency Injection Integration', () => {
    test('should work with DI container', () => {
      const container = createTestContainer();
      container.instance('config', mockConfig);
      container.instance('logger', mockLogger);
      container.register(
        'databaseManager',
        (cfg, log) => new InjectableDatabaseManager(cfg, log),
        { dependencies: ['config', 'logger'] }
      );

      const dm = container.get('databaseManager');
      expect(dm).toBeInstanceOf(InjectableDatabaseManager);
      expect(dm.defaultDatabase).toBe('main');
    });

    test('should support mocking in DI container', () => {
      const container = createTestContainer();
      const mockDm = {
        getPool:         jest.fn().mockReturnValue({ acquire: jest.fn() }),
        isValidDatabase: jest.fn().mockReturnValue(true)
      };

      container.mock('databaseManager', mockDm);
      expect(container.get('databaseManager')).toBe(mockDm);
    });
  });

  // ── Error handling & edge cases ───────────────────────────────────────────

  describe('Error Handling and Edge Cases', () => {
    test('should not throw when database files are missing', () => {
      fsExists.mockReturnValue(false);
      expect(() => new InjectableDatabaseManager(mockConfig, mockLogger)).not.toThrow();
    });

    test('should warn when database files are missing', () => {
      fsExists.mockReturnValue(false);
      new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Database file not found'),
        expect.any(Object)
      );
    });

    test('should throw when DATABASES is empty and default cannot initialize', () => {
      const invalidConfig = {
        DATABASE_ROUTING: {
          DEFAULT_DATABASE:            'main',
          ALLOWED_DATABASES:           ['main'],
          ALLOW_CROSS_DATABASE_QUERIES: true
        },
        DATABASES: {}
      };

      expect(() => new InjectableDatabaseManager(invalidConfig, mockLogger))
        .toThrow("Default database 'main' failed to initialize");
    });

    test('should handle concurrent operations without error', async () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);

      const results = await Promise.all([
        Promise.resolve(dm.getPool('main')),
        Promise.resolve(dm.getPool('test')),
        Promise.resolve(dm.getStatistics()),
        Promise.resolve(dm.validateDatabaseRouting('analytics'))
      ]);

      expect(results).toHaveLength(4);
      results.forEach(r => expect(r).toBeDefined());
    });
  });
});
