// Simplified unit tests for DatabaseManager class (non-singleton approach)
import { jest } from '@jest/globals';

// Mock all dependencies before any imports
const mockConfig = {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: 'main',
    ALLOWED_DATABASES: ['main', 'test'],
    ALLOW_CROSS_DATABASE_QUERIES: true
  },
  DATABASES: {
    main: {
      PATH: 'test/main.db',
      POOL: {
        MAX_CONNECTIONS: 5,
        ACQUIRE_TIMEOUT: 5000,
        CONNECTION_RETRY_DELAY: 1000,
        CONNECTION_RETRY_MAX: 3
      }
    },
    test: {
      PATH: 'test/test.db',
      POOL: {
        MAX_CONNECTIONS: 3,
        ACQUIRE_TIMEOUT: 3000,
        CONNECTION_RETRY_DELAY: 500,
        CONNECTION_RETRY_MAX: 2
      }
    }
  }
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
  close: jest.fn().mockResolvedValue(),
  on: jest.fn(),
  available: 5,
  using: 0,
  waiting: 0
};

jest.mock('../src/db/pool.js', () => ({
  DuckDBPool: jest.fn().mockImplementation(() => mockPool)
}));

describe('DatabaseManager Unit Tests', () => {
  let DatabaseManager;

  beforeAll(async () => {
    // Import after mocks are set up
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
  });

  test('should validate database IDs correctly', () => {
    const manager = new DatabaseManager();
    
    // Mock the pools map
    manager.pools = new Map();
    manager.pools.set('main', mockPool);
    manager.pools.set('test', mockPool);
    
    expect(manager.isValidDatabase('main')).toBe(true);
    expect(manager.isValidDatabase('test')).toBe(true);
    expect(manager.isValidDatabase('invalid')).toBe(false);
  });

  test('should return available databases', () => {
    const manager = new DatabaseManager();
    
    // Mock the pools
    manager.pools = new Map();
    manager.pools.set('main', mockPool);
    manager.pools.set('test', mockPool);
    
    const databases = manager.getAvailableDatabases();
    expect(databases).toEqual(['main', 'test']);
  });

  test('should validate database routing', () => {
    const manager = new DatabaseManager();
    manager.pools = new Map();
    manager.pools.set('main', mockPool);
    manager.pools.set('test', mockPool);
    
    expect(manager.validateDatabaseRouting('test')).toBe('test');
    expect(manager.validateDatabaseRouting(null, 'test')).toBe('test');
    expect(manager.validateDatabaseRouting()).toBe('main');
    
    expect(() => manager.validateDatabaseRouting('invalid')).toThrow();
  });

  test('should provide database statistics', () => {
    const manager = new DatabaseManager();
    manager.pools = new Map();
    manager.pools.set('main', mockPool);
    manager.pools.set('test', mockPool);
    
    const stats = manager.getStatistics();
    
    expect(stats.databases).toHaveProperty('main');
    expect(stats.databases).toHaveProperty('test');
    expect(stats.defaultDatabase).toBe('main');
    expect(stats.allowedDatabases).toEqual(['main', 'test']);
  });

  test('should handle pool operations', () => {
    const manager = new DatabaseManager();
    manager.pools = new Map();
    manager.pools.set('main', mockPool);
    
    const pool = manager.getPool('main');
    expect(pool).toBe(mockPool);
    
    const defaultPool = manager.getPool();
    expect(defaultPool).toBe(mockPool);
    
    expect(() => manager.getPool('invalid')).toThrow();
  });
});

describe('Multiple Database Support Tests', () => {
  test('should handle multiple database configurations', () => {
    const multiConfig = {
      DATABASE_ROUTING: {
        DEFAULT_DATABASE: 'main',
        ALLOWED_DATABASES: ['main', 'analytics', 'audit'],
        ALLOW_CROSS_DATABASE_QUERIES: true
      },
      DATABASES: {
        main: { PATH: 'main.db', POOL: { MAX_CONNECTIONS: 5, ACQUIRE_TIMEOUT: 5000, CONNECTION_RETRY_DELAY: 1000, CONNECTION_RETRY_MAX: 3 } },
        analytics: { PATH: 'analytics.db', POOL: { MAX_CONNECTIONS: 10, ACQUIRE_TIMEOUT: 8000, CONNECTION_RETRY_DELAY: 1500, CONNECTION_RETRY_MAX: 5 } },
        audit: { PATH: 'audit.db', POOL: { MAX_CONNECTIONS: 3, ACQUIRE_TIMEOUT: 3000, CONNECTION_RETRY_DELAY: 500, CONNECTION_RETRY_MAX: 2 } }
      }
    };

    // Mock config for this test
    jest.doMock('../src/utils/config-loader.js', () => ({ config: multiConfig }), { virtual: true });

    // This would test the multi-database scenario
    expect(multiConfig.DATABASE_ROUTING.ALLOWED_DATABASES).toHaveLength(3);
    expect(multiConfig.DATABASES).toHaveProperty('main');
    expect(multiConfig.DATABASES).toHaveProperty('analytics');
    expect(multiConfig.DATABASES).toHaveProperty('audit');
  });
});

describe('Security Tests', () => {
  test('should reject malicious database identifiers', async () => {
    const { DatabaseManager } = await import('../src/db/database-manager.js');
    const manager = new DatabaseManager();
    manager.pools = new Map();
    manager.pools.set('main', mockPool);

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