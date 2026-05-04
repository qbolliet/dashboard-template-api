/**
 * Unit tests for InjectableDatabaseManager (tests/setup/database-manager-injectable.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks DuckDBPool and the fs module to isolate initialization logic.
 * Covers constructor, pool management, validation, statistics, close,
 * dependency injection integration, and error handling.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration d'un pool mocké — simulation de DuckDBPool. */
interface MockPool {
  config:    Record<string, unknown>;
  available: number;
  using:     number;
  waiting:   number;
  close:     jest.Mock;
  on:        jest.Mock;
  acquire:   jest.Mock;
  release:   jest.Mock;
}

/** Configuration passée au constructeur DuckDBPool mocké. */
interface MockPoolConfig {
  maxConnections?: number;
  [key: string]:   unknown;
}

/** Logger mocké — toutes les méthodes de journalisation. */
interface MockLogger {
  database: jest.Mock;
  warn:     jest.Mock;
  error:    jest.Mock;
  info:     jest.Mock;
}

/** Configuration complète d'une base de données individuelle. */
interface DatabaseEntry {
  PATH: string;
  POOL: {
    MAX_CONNECTIONS:        number;
    ACQUIRE_TIMEOUT:        number;
    CONNECTION_RETRY_DELAY: number;
    CONNECTION_RETRY_MAX:   number;
  };
}

/** Configuration complète du routage et des bases de données. */
interface ManagerConfig {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE:             string;
    ALLOWED_DATABASES:            string[];
    ALLOW_CROSS_DATABASE_QUERIES: boolean;
    AUTO_INITIALIZE?:             boolean;
  };
  DATABASES: Record<string, DatabaseEntry>;
}

/** Statistiques de fichier mockées retournées par fs.statSync. */
interface MockFileStat {
  size:  number;
  mtime: Date;
}

// ─── État partagé des mocks ───────────────────────────────────────────────────

// Simulation des méthodes fs utilisées lors de l'initialisation
const fsExists: jest.Mock = jest.fn().mockReturnValue(true);
const fsStat:   jest.Mock = jest.fn().mockReturnValue<MockFileStat>({
  size:  1024000,
  mtime: new Date('2023-01-01')
});

/**
 * Create a mock DuckDBPool instance from a given configuration.
 *
 * Args:
 *     cfg: Pool configuration to reflect in the mock instance.
 *
 * Returns:
 *     A MockPool object with jest mock methods.
 */
const makeMockPool = (cfg: MockPoolConfig = {}): MockPool => ({
  config:    cfg,
  available: cfg.maxConnections as number ?? 5,
  using:     0,
  waiting:   0,
  close:     jest.fn().mockResolvedValue(undefined),
  on:        jest.fn(),
  acquire:   jest.fn().mockResolvedValue({ id: 'test-conn' }),
  release:   jest.fn()
});

// Constructeur DuckDBPool mocké — retourne un pool conforme à MockPool
const MockDuckDBPool: jest.Mock = jest.fn().mockImplementation(
  (cfg: MockPoolConfig) => makeMockPool(cfg)
);

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/pool.js', () => ({ DuckDBPool: MockDuckDBPool }));
jest.unstable_mockModule('fs', () => ({
  default:    { existsSync: fsExists, statSync: fsStat },
  existsSync: fsExists,
  statSync:   fsStat
}));

// ─── Imports dynamiques ───────────────────────────────────────────────────────

// Types d'import — résolus après enregistrement des mocks
type InjectableDatabaseManagerConstructor = new (
  config: ManagerConfig,
  logger?: Partial<MockLogger>
) => InstanceType<InjectableDatabaseManagerConstructor>;

let InjectableDatabaseManager: InjectableDatabaseManagerConstructor;
let createTestContainer:       () => { instance: jest.Mock; register: jest.Mock; get: jest.Mock; mock: jest.Mock };
let DuckDBPool:                 jest.Mock;

beforeAll(async () => {
  ({ InjectableDatabaseManager } = await import('../../setup/database-manager-injectable.js') as unknown as {
    InjectableDatabaseManager: InjectableDatabaseManagerConstructor;
  });
  ({ createTestContainer } = await import('../../setup/di-container.js') as unknown as {
    createTestContainer: () => ReturnType<typeof createTestContainer>;
  });
  ({ DuckDBPool } = await import('../../../src/db/pool.js') as unknown as { DuckDBPool: jest.Mock });
});

// ─── Fabrique de configuration ────────────────────────────────────────────────

/**
 * Build a standard test configuration with three databases.
 *
 * Returns:
 *     A ManagerConfig with main, test, and analytics databases configured.
 */
const makeConfig = (): ManagerConfig => ({
  DATABASE_ROUTING: {
    DEFAULT_DATABASE:             'main',
    ALLOWED_DATABASES:            ['main', 'test', 'analytics'],
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
  let mockConfig: ManagerConfig;
  let mockLogger: MockLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    MockDuckDBPool.mockImplementation((cfg: MockPoolConfig) => makeMockPool(cfg));
    fsExists.mockReturnValue(true);
    fsStat.mockReturnValue<MockFileStat>({ size: 1024000, mtime: new Date('2023-01-01') });
    mockConfig = makeConfig();
    mockLogger = {
      database: jest.fn(),
      warn:     jest.fn(),
      error:    jest.fn(),
      info:     jest.fn()
    };
  });

  // ── Constructeur et initialisation ────────────────────────────────────────

  describe('Constructor and Initialization', () => {
    test('should initialize with correct configuration', () => {
      const dm = new InjectableDatabaseManager(mockConfig, mockLogger);
      expect(dm.defaultDatabase).toBe('main');
      expect(dm.allowedDatabases).toEqual(['main', 'test', 'analytics']);
      expect(dm.allowCrossDatabase).toBe(true);
      expect(dm.pools.size).toBe(3);
    });

    test('should throw error without required configuration', () => {
      expect(() => new InjectableDatabaseManager({} as ManagerConfig, mockLogger))
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

  // ── Gestion des pools ─────────────────────────────────────────────────────

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
      expect(dm.isValidDatabase(null as unknown as string)).toBe(false);
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

  // ── Statistiques ──────────────────────────────────────────────────────────

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

  // ── Fermeture ─────────────────────────────────────────────────────────────

  describe('Database Operations', () => {
    test('should close all database pools', async () => {
      const dm       = new InjectableDatabaseManager(mockConfig, mockLogger);
      const mainPool = dm.getPool('main') as MockPool;
      const testPool = dm.getPool('test') as MockPool;

      await dm.close();

      expect(mainPool.close).toHaveBeenCalled();
      expect(testPool.close).toHaveBeenCalled();
      expect(dm.pools.size).toBe(0);
    });

    test('should propagate errors during close', async () => {
      const dm       = new InjectableDatabaseManager(mockConfig, mockLogger);
      const mainPool = dm.getPool('main') as MockPool;
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

  // ── Configuration par base de données ────────────────────────────────────

  describe('Multiple Database Scenarios', () => {
    test('should initialize each database with its specific maxConnections', () => {
      new InjectableDatabaseManager(mockConfig, mockLogger);
      const maxConns = MockDuckDBPool.mock.calls.map((c: unknown[]) => (c[0] as MockPoolConfig).maxConnections);
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

  // ── Intégration DI ────────────────────────────────────────────────────────

  describe('Dependency Injection Integration', () => {
    test('should work with DI container', () => {
      const container = createTestContainer();
      container.instance('config', mockConfig);
      container.instance('logger', mockLogger);
      container.register(
        'databaseManager',
        (cfg: unknown, log: unknown) => new InjectableDatabaseManager(
          cfg as ManagerConfig,
          log as Partial<MockLogger>
        ),
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

  // ── Gestion des erreurs et cas limites ────────────────────────────────────

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
      const invalidConfig: ManagerConfig = {
        DATABASE_ROUTING: {
          DEFAULT_DATABASE:             'main',
          ALLOWED_DATABASES:            ['main'],
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
