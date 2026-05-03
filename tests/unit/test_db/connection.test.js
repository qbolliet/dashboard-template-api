// Unit tests for connection.js (src/db/connection.js)
// Verifies the compatibility layer that wraps databaseManager.
import { jest } from '@jest/globals';

// ─── Mock state ───────────────────────────────────────────────────────────────

const mockSharedPool = {
  pool:           [],
  maxConnections: 5,
  catalogs:       [{ alias: 'main' }],
  acquire:        jest.fn().mockResolvedValue({}),
  release:        jest.fn(),
  close:          jest.fn().mockResolvedValue(undefined)
};

const mockDatabaseManager = {
  getPool:                   jest.fn().mockReturnValue(mockSharedPool),
  isValidDatabase:           jest.fn().mockReturnValue(true),
  getAvailableDatabases:     jest.fn().mockReturnValue(['main']),
  getDefaultDatabase:        jest.fn().mockReturnValue('main'),
  isCrossDatabaseAllowed:    jest.fn().mockReturnValue(false),
  validateDatabaseRouting:   jest.fn().mockReturnValue('main'),
  getStatistics:             jest.fn().mockReturnValue({}),
  close:                     jest.fn().mockResolvedValue(undefined)
};

const mockCloseAllConnections = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/db/database-manager.js', () => ({
  databaseManager:      mockDatabaseManager,
  closeAllConnections:  mockCloseAllConnections,
  DatabaseManager:      jest.fn()
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    database: jest.fn(),
    warn:     jest.fn(),
    error:    jest.fn()
  })
}));

// ─── Dynamic import ───────────────────────────────────────────────────────────

let dbPool;
let closeConnections;
let getDefaultPool;
let databaseManager;
let closeAllConnections;

beforeAll(async () => {
  ({
    dbPool,
    closeConnections,
    getDefaultPool,
    databaseManager,
    closeAllConnections
  } = await import('../../src/db/connection.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('connection.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockSharedPool);
    mockCloseAllConnections.mockResolvedValue(undefined);
  });

  describe('dbPool (module-level default pool)', () => {
    test('is defined', () => {
      expect(dbPool).toBeDefined();
    });

    test('is the value returned by databaseManager.getPool() at load time', () => {
      // dbPool is set once at module load; it equals whatever getPool() returned then.
      expect(dbPool).toBe(mockSharedPool);
    });
  });

  describe('getDefaultPool', () => {
    test('returns the shared pool from databaseManager', () => {
      const pool = getDefaultPool();
      expect(pool).toBe(mockSharedPool);
      expect(mockDatabaseManager.getPool).toHaveBeenCalled();
    });

    test('calls databaseManager.getPool with no arguments', () => {
      getDefaultPool();
      expect(mockDatabaseManager.getPool).toHaveBeenCalledWith();
    });
  });

  describe('closeConnections', () => {
    test('delegates to closeAllConnections', async () => {
      await closeConnections();
      expect(mockCloseAllConnections).toHaveBeenCalled();
    });

    test('resolves without error on success', async () => {
      await expect(closeConnections()).resolves.toBeUndefined();
    });

    test('propagates errors from closeAllConnections', async () => {
      mockCloseAllConnections.mockRejectedValueOnce(new Error('close error'));
      await expect(closeConnections()).rejects.toThrow('close error');
    });
  });

  describe('re-exported references', () => {
    test('databaseManager is the singleton from database-manager.js', () => {
      expect(databaseManager).toBe(mockDatabaseManager);
    });

    test('closeAllConnections is exported', () => {
      expect(typeof closeAllConnections).toBe('function');
    });
  });
});
