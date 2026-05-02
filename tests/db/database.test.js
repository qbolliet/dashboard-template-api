// Unit tests for DatabaseManager (src/db/database-manager.js)
// Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
import { jest } from '@jest/globals';

// ─── Shared mutable mock state ───────────────────────────────────────────────

const mockConfig = {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: 'main',
    ALLOWED_DATABASES: ['main', 'test', 'analytics'],
    ALLOW_CROSS_DATABASE_QUERIES: true
  },
  CATALOGS: {
    main:      { PATH: 'data/main.ducklake',      DATA_PATH: 'data/main_data/',      READ_ONLY: true  },
    test:      { PATH: 'data/test.ducklake',      DATA_PATH: 'data/test_data/',      READ_ONLY: false },
    analytics: { PATH: 'data/analytics.ducklake', DATA_PATH: 'data/analytics_data/', READ_ONLY: true  }
  },
  DATABASE: {
    POOL: { MAX_CONNECTIONS: 5, ACQUIRE_TIMEOUT: 5000, POOL_RETRY_DELAY: 50 }
  },
  S3: { ENABLED: false }
};

const mockLogger = {
  database: jest.fn(),
  warn:     jest.fn(),
  error:    jest.fn(),
  info:     jest.fn()
};

const fsExists = jest.fn().mockReturnValue(true);
const fsStat   = jest.fn().mockReturnValue({ size: 1024, mtime: new Date() });

const makeMockPool = (cfg = {}) => ({
  pool:           [],
  maxConnections: cfg.maxConnections ?? 5,
  catalogs:       cfg.catalogs ?? [],
  close:          jest.fn().mockResolvedValue(undefined),
  acquire:        jest.fn().mockResolvedValue({}),
  release:        jest.fn()
});

const MockDuckDBPool = jest.fn().mockImplementation(cfg => makeMockPool(cfg));

// ─── Mock registration (must precede any dynamic import) ─────────────────────

jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({ config: mockConfig }));
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createContextLogger: () => mockLogger
}));
jest.unstable_mockModule('../../src/db/pool.js', () => ({ DuckDBPool: MockDuckDBPool }));
jest.unstable_mockModule('fs', () => ({
  default:    { existsSync: fsExists, statSync: fsStat },
  existsSync: fsExists,
  statSync:   fsStat
}));

// ─── Dynamic import ───────────────────────────────────────────────────────────

let DatabaseManager;

beforeAll(async () => {
  ({ DatabaseManager } = await import('../../src/db/database-manager.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DatabaseManager', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    MockDuckDBPool.mockImplementation(cfg => makeMockPool(cfg));
    fsExists.mockReturnValue(true);
    fsStat.mockReturnValue({ size: 1024, mtime: new Date() });
    manager = new DatabaseManager();
  });

  // ── Constructor & initialization ──────────────────────────────────────────

  describe('Constructor and initialization', () => {
    test('reads defaultDatabase from config', () => {
      expect(manager.defaultDatabase).toBe('main');
    });

    test('reads allowedDatabases from config', () => {
      expect(manager.allowedDatabases).toEqual(['main', 'test', 'analytics']);
    });

    test('reads allowCrossDatabase from config', () => {
      expect(manager.allowCrossDatabase).toBe(true);
    });

    test('creates a single shared DuckDBPool containing all catalog aliases', () => {
      expect(MockDuckDBPool).toHaveBeenCalledTimes(1);
      const [poolCfg] = MockDuckDBPool.mock.calls[0];
      const aliases = poolCfg.catalogs.map(c => c.alias);
      expect(aliases).toContain('main');
      expect(aliases).toContain('test');
      expect(aliases).toContain('analytics');
    });

    test('passes correct pool settings to DuckDBPool', () => {
      const [poolCfg] = MockDuckDBPool.mock.calls[0];
      expect(poolCfg.maxConnections).toBe(5);
      expect(poolCfg.acquireTimeout).toBe(5000);
    });

    test('catalogs include readOnly and dataPath', () => {
      const [poolCfg] = MockDuckDBPool.mock.calls[0];
      const main = poolCfg.catalogs.find(c => c.alias === 'main');
      expect(main.readOnly).toBe(true);
      expect(main.dataPath).toMatch(/\/$/); // dataPath must end with /
    });

    test('logs a warning when a catalog file is missing', () => {
      fsExists.mockReturnValue(false);
      new DatabaseManager();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('does not throw when catalog files are missing', () => {
      fsExists.mockReturnValue(false);
      expect(() => new DatabaseManager()).not.toThrow();
    });

    test('throws when default catalog is absent from CATALOGS', () => {
      const savedCatalogs = mockConfig.CATALOGS;
      mockConfig.CATALOGS = {
        other: { PATH: 'other.ducklake', DATA_PATH: 'other_data/', READ_ONLY: true }
      };
      try {
        expect(() => new DatabaseManager())
          .toThrow("Default database 'main' not found in CATALOGS config");
      } finally {
        mockConfig.CATALOGS = savedCatalogs;
      }
    });

    test('error lists available catalogs when default is absent', () => {
      const savedCatalogs = mockConfig.CATALOGS;
      mockConfig.CATALOGS = {
        other: { PATH: 'other.ducklake', DATA_PATH: 'other_data/', READ_ONLY: true }
      };
      try {
        expect(() => new DatabaseManager()).toThrow('Available: other');
      } finally {
        mockConfig.CATALOGS = savedCatalogs;
      }
    });
  });

  // ── getPool ───────────────────────────────────────────────────────────────

  describe('getPool', () => {
    test('returns the shared pool when no catalogId is specified', () => {
      expect(manager.getPool()).toBe(manager.sharedPool);
    });

    test('returns the same shared pool for any valid catalogId', () => {
      expect(manager.getPool('main')).toBe(manager.sharedPool);
      expect(manager.getPool('test')).toBe(manager.sharedPool);
      expect(manager.getPool('analytics')).toBe(manager.sharedPool);
    });

    test('null catalogId falls back to default', () => {
      expect(manager.getPool(null)).toBe(manager.sharedPool);
    });

    test('throws for an unknown catalogId', () => {
      expect(() => manager.getPool('nonexistent'))
        .toThrow("Database 'nonexistent' is not allowed or not configured");
    });
  });

  // ── isValidDatabase ───────────────────────────────────────────────────────

  describe('isValidDatabase', () => {
    test('returns true for each configured catalog', () => {
      expect(manager.isValidDatabase('main')).toBe(true);
      expect(manager.isValidDatabase('test')).toBe(true);
      expect(manager.isValidDatabase('analytics')).toBe(true);
    });

    test('returns false for unknown catalog', () => {
      expect(manager.isValidDatabase('unknown')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(manager.isValidDatabase('')).toBe(false);
    });

    test('returns false for null', () => {
      expect(manager.isValidDatabase(null)).toBe(false);
    });
  });

  // ── getAvailableDatabases ─────────────────────────────────────────────────

  describe('getAvailableDatabases', () => {
    test('returns all allowed catalog IDs', () => {
      expect(manager.getAvailableDatabases()).toEqual(['main', 'test', 'analytics']);
    });

    test('returns a copy — mutations do not affect internal state', () => {
      const dbs = manager.getAvailableDatabases();
      dbs.push('extra');
      expect(manager.getAvailableDatabases()).not.toContain('extra');
    });
  });

  // ── getDefaultDatabase ────────────────────────────────────────────────────

  describe('getDefaultDatabase', () => {
    test('returns the configured default catalog', () => {
      expect(manager.getDefaultDatabase()).toBe('main');
    });
  });

  // ── getSchema ─────────────────────────────────────────────────────────────

  describe('getSchema', () => {
    test('returns "main" when no SCHEMA is configured for a catalog', () => {
      expect(manager.getSchema('main')).toBe('main');
    });

    test('returns default schema for an unknown catalogId', () => {
      expect(manager.getSchema('unknown')).toBe('main');
    });

    test('returns configured SCHEMA when present', () => {
      const savedCatalogs = mockConfig.CATALOGS;
      mockConfig.CATALOGS = {
        main: { PATH: 'main.ducklake', DATA_PATH: 'main_data/', READ_ONLY: true, SCHEMA: 'custom_schema' }
      };
      const m = new DatabaseManager();
      expect(m.getSchema('main')).toBe('custom_schema');
      mockConfig.CATALOGS = savedCatalogs;
    });
  });

  // ── isCrossDatabaseAllowed ────────────────────────────────────────────────

  describe('isCrossDatabaseAllowed', () => {
    test('returns the configured ALLOW_CROSS_DATABASE_QUERIES value', () => {
      expect(manager.isCrossDatabaseAllowed()).toBe(true);
    });
  });

  // ── validateDatabaseRouting ───────────────────────────────────────────────

  describe('validateDatabaseRouting', () => {
    test('returns requested catalog when valid', () => {
      expect(manager.validateDatabaseRouting('test')).toBe('test');
    });

    test('falls back to context catalog when no explicit request', () => {
      expect(manager.validateDatabaseRouting(null, 'analytics')).toBe('analytics');
    });

    test('falls back to default when neither is specified', () => {
      expect(manager.validateDatabaseRouting()).toBe('main');
    });

    test('explicit request takes priority over context', () => {
      expect(manager.validateDatabaseRouting('test', 'analytics')).toBe('test');
    });

    test('throws for an invalid catalog', () => {
      expect(() => manager.validateDatabaseRouting('invalid'))
        .toThrow("Database 'invalid' is not available");
    });

    test('error message lists available databases', () => {
      expect(() => manager.validateDatabaseRouting('invalid'))
        .toThrow('Available databases: main, test, analytics');
    });
  });

  // ── getStatistics ─────────────────────────────────────────────────────────

  describe('getStatistics', () => {
    test('returns routing configuration fields', () => {
      const stats = manager.getStatistics();
      expect(stats.defaultDatabase).toBe('main');
      expect(stats.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(stats.allowCrossDatabase).toBe(true);
    });

    test('returns pool stats with attachedCatalogs', () => {
      const { sharedPool } = manager.getStatistics();
      expect(sharedPool).toBeDefined();
      expect(sharedPool.attachedCatalogs).toEqual(
        expect.arrayContaining(['main', 'test', 'analytics'])
      );
    });

    test('sharedPool stats include available/using/total/maxConnections', () => {
      const { sharedPool } = manager.getStatistics();
      expect(sharedPool).toHaveProperty('available');
      expect(sharedPool).toHaveProperty('using');
      expect(sharedPool).toHaveProperty('total');
      expect(sharedPool).toHaveProperty('maxConnections');
    });

    test('returns null sharedPool when pool is not initialized', () => {
      manager.sharedPool = null;
      expect(manager.getStatistics().sharedPool).toBeNull();
    });
  });

  // ── close ─────────────────────────────────────────────────────────────────

  describe('close', () => {
    test('delegates to pool.close()', async () => {
      const pool = manager.sharedPool;
      await manager.close();
      expect(pool.close).toHaveBeenCalledTimes(1);
    });

    test('sets sharedPool to null after closing', async () => {
      await manager.close();
      expect(manager.sharedPool).toBeNull();
    });

    test('propagates pool close errors', async () => {
      manager.sharedPool.close.mockRejectedValueOnce(new Error('Pool close failed'));
      await expect(manager.close()).rejects.toThrow('Pool close failed');
    });

    test('resolves without error when sharedPool is already null', async () => {
      manager.sharedPool = null;
      await expect(manager.close()).resolves.toBeUndefined();
    });
  });
});

// ── Concurrent operations ─────────────────────────────────────────────────────

describe('DatabaseManager — concurrent operations', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    MockDuckDBPool.mockImplementation(cfg => makeMockPool(cfg));
    fsExists.mockReturnValue(true);
    fsStat.mockReturnValue({ size: 1024, mtime: new Date() });
    manager = new DatabaseManager();
  });

  test('concurrent getPool calls all return the same shared pool', async () => {
    const results = await Promise.all([
      Promise.resolve(manager.getPool('main')),
      Promise.resolve(manager.getPool('test')),
      Promise.resolve(manager.getPool('analytics'))
    ]);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  test('concurrent validateDatabaseRouting calls all succeed', async () => {
    const results = await Promise.all(
      ['main', 'test', 'analytics'].map(db =>
        Promise.resolve(manager.validateDatabaseRouting(db))
      )
    );
    expect(results).toEqual(['main', 'test', 'analytics']);
  });

  test('mix of operations runs without interference', async () => {
    const results = await Promise.all([
      Promise.resolve(manager.getPool('main')),
      Promise.resolve(manager.getStatistics()),
      Promise.resolve(manager.isValidDatabase('test')),
      Promise.resolve(manager.validateDatabaseRouting('analytics'))
    ]);
    expect(results).toHaveLength(4);
    results.forEach(r => expect(r).toBeDefined());
  });
});
