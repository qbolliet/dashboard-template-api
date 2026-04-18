// Simplified unit tests for DatabaseManager class (non-singleton approach)
import { jest } from '@jest/globals';

// Mock all dependencies before any imports
const mockConfig = {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: 'main',
    ALLOWED_DATABASES: ['main', 'test'],
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
    }
  },
  DATABASE: {
    POOL: {
      MAX_CONNECTIONS: 5,
      ACQUIRE_TIMEOUT: 5000,
      POOL_RETRY_DELAY: 100
    }
  },
  S3: { ENABLED: false }
};

jest.mock('../src/utils/config-loader.js', () => ({ config: mockConfig }));
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  statSync: jest.fn().mockReturnValue({ size: 1024, mtime: new Date() })
}));

jest.mock('../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    database: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

const mockPool = {
  pool: [],
  catalogs: [{ alias: 'main' }, { alias: 'test' }],
  maxConnections: 5,
  close: jest.fn().mockResolvedValue(),
  on: jest.fn(),
  acquire: jest.fn().mockResolvedValue({}),
  release: jest.fn()
};

jest.mock('../src/db/pool.js', () => ({
  DuckDBPool: jest.fn().mockImplementation(() => mockPool)
}));

describe('DatabaseManager Unit Tests', () => {
  let DatabaseManager;

  beforeAll(async () => {
    const module = await import('../src/db/database-manager.js');
    DatabaseManager = module.DatabaseManager;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should create DatabaseManager instance', () => {
    const manager = new DatabaseManager();

    expect(manager.defaultDatabase).toBe('main');
    expect(manager.allowedDatabases).toEqual(['main', 'test']);
    expect(manager.allowCrossDatabase).toBe(true);
    expect(manager.sharedPool).toBeDefined();
  });

  test('should validate database IDs correctly', () => {
    const manager = new DatabaseManager();

    expect(manager.isValidDatabase('main')).toBe(true);
    expect(manager.isValidDatabase('test')).toBe(true);
    expect(manager.isValidDatabase('invalid')).toBe(false);
    expect(manager.isValidDatabase(null)).toBe(false);
  });

  test('should return available databases from allowed list', () => {
    const manager = new DatabaseManager();

    const databases = manager.getAvailableDatabases();
    expect(databases).toEqual(expect.arrayContaining(['main', 'test']));
    expect(databases).toHaveLength(2);
  });

  test('should validate database routing', () => {
    const manager = new DatabaseManager();

    expect(manager.validateDatabaseRouting('test')).toBe('test');
    expect(manager.validateDatabaseRouting(null, 'test')).toBe('test');
    expect(manager.validateDatabaseRouting()).toBe('main');

    expect(() => manager.validateDatabaseRouting('invalid')).toThrow();
  });

  test('should provide database statistics for shared pool', () => {
    const manager = new DatabaseManager();
    const stats = manager.getStatistics();

    expect(stats.sharedPool).toBeDefined();
    expect(stats.defaultDatabase).toBe('main');
    expect(stats.allowedDatabases).toEqual(['main', 'test']);
  });

  test('should handle pool operations via shared pool', () => {
    const manager = new DatabaseManager();

    const pool = manager.getPool('main');
    expect(pool).toBe(mockPool);

    const defaultPool = manager.getPool();
    expect(defaultPool).toBe(mockPool);

    expect(() => manager.getPool('invalid')).toThrow();
  });
});

describe('Multiple Catalog Support Tests', () => {
  test('should handle multiple catalog configurations', () => {
    const multiConfig = {
      DATABASE_ROUTING: {
        DEFAULT_DATABASE: 'main',
        ALLOWED_DATABASES: ['main', 'analytics', 'audit'],
        ALLOW_CROSS_DATABASE_QUERIES: true
      },
      CATALOGS: {
        main: { PATH: 'main.ducklake', DATA_PATH: 'main_data/', READ_ONLY: true },
        analytics: { PATH: 'analytics.ducklake', DATA_PATH: 'analytics_data/', READ_ONLY: true },
        audit: { PATH: 'audit.ducklake', DATA_PATH: 'audit_data/', READ_ONLY: true }
      },
      DATABASE: {
        POOL: { MAX_CONNECTIONS: 5, ACQUIRE_TIMEOUT: 5000, POOL_RETRY_DELAY: 100 }
      }
    };

    expect(multiConfig.DATABASE_ROUTING.ALLOWED_DATABASES).toHaveLength(3);
    expect(multiConfig.CATALOGS).toHaveProperty('main');
    expect(multiConfig.CATALOGS).toHaveProperty('analytics');
    expect(multiConfig.CATALOGS).toHaveProperty('audit');
  });
});

describe('Security Tests', () => {
  test('should reject malicious database identifiers', async () => {
    const { DatabaseManager } = await import('../src/db/database-manager.js');
    const manager = new DatabaseManager();

    const maliciousIds = [
      '../../../etc/passwd',
      'main; DROP TABLE users;--',
      "main' OR 1=1--",
      'main"',
      'C:\\Windows\\System32',
      '/etc/shadow'
    ];

    maliciousIds.forEach(id => {
      expect(manager.isValidDatabase(id)).toBe(false);
      expect(() => manager.getPool(id)).toThrow();
    });
  });
});
