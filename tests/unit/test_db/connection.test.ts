/**
 * Unit tests for connection.js (src/db/connection.js).
 *
 * Verifies the compatibility layer wrapping databaseManager:
 * module-level dbPool, getDefaultPool(), closeConnections(),
 * and re-exported databaseManager / closeAllConnections.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Pool partagé mocké — simulation du DuckDBPool pour les tests de connection. */
interface MockSharedPool {
  pool: unknown[];
  maxConnections: number;
  catalogs: { alias: string }[];
  acquire: jest.Mock;
  release: jest.Mock;
  close: jest.Mock;
}

/** Gestionnaire de base de données mocké — simulation du singleton DatabaseManager. */
interface MockDatabaseManager {
  getPool: jest.Mock;
  isValidCatalog: jest.Mock;
  getAvailableCatalogs: jest.Mock;
  getDefaultCatalog: jest.Mock;
  isCrossCatalogAllowed: jest.Mock;
  validateCatalogRouting: jest.Mock;
  getStatistics: jest.Mock;
  close: jest.Mock;
}

/** Module connection.js après import dynamique — exports attendus. */
interface ConnectionModule {
  dbPool: MockSharedPool;
  closeConnections: () => Promise<void>;
  getDefaultPool: () => MockSharedPool;
  databaseManager: MockDatabaseManager;
  closeAllConnections: jest.Mock;
}

// ─── État des mocks ───────────────────────────────────────────────────────────

const mockSharedPool: MockSharedPool = {
  pool: [],
  maxConnections: 5,
  catalogs: [{ alias: 'main' }],
  acquire: jest.fn().mockResolvedValue({}),
  release: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
};

const mockDatabaseManager: MockDatabaseManager = {
  getPool: jest.fn().mockReturnValue(mockSharedPool),
  isValidCatalog: jest.fn().mockReturnValue(true),
  getAvailableCatalogs: jest.fn().mockReturnValue(['main']),
  getDefaultCatalog: jest.fn().mockReturnValue('main'),
  isCrossCatalogAllowed: jest.fn().mockReturnValue(false),
  validateCatalogRouting: jest.fn().mockReturnValue('main'),
  getStatistics: jest.fn().mockReturnValue({}),
  close: jest.fn().mockResolvedValue(undefined),
};

// Fonction de fermeture globale mockée — délégation depuis closeConnections
const mockCloseAllConnections: jest.Mock = jest.fn().mockResolvedValue(undefined);

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/database-manager.js', () => ({
  databaseManager: mockDatabaseManager,
  closeAllConnections: mockCloseAllConnections,
  DatabaseManager: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    database: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Variables déclarées avant beforeAll — remplies après résolution des mocks
let dbPool: MockSharedPool;
let closeConnections: () => Promise<void>;
let getDefaultPool: () => MockSharedPool;
let databaseManager: MockDatabaseManager;
let closeAllConnections: jest.Mock;

beforeAll(async () => {
  ({ dbPool, closeConnections, getDefaultPool, databaseManager, closeAllConnections } =
    (await import('../../../src/db/connection.js')) as unknown as ConnectionModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('connection.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockSharedPool);
    mockCloseAllConnections.mockResolvedValue(undefined);
  });

  // ── Pool par défaut au niveau module ──────────────────────────────────────

  describe('dbPool (module-level default pool)', () => {
    test('is defined', () => {
      expect(dbPool).toBeDefined();
    });

    test('is the value returned by databaseManager.getPool() at load time', () => {
      // dbPool fixé une seule fois au chargement du module
      expect(dbPool).toBe(mockSharedPool);
    });
  });

  // ── Accesseur du pool par défaut ──────────────────────────────────────────

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

  // ── Fermeture des connexions ──────────────────────────────────────────────

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

  // ── Références ré-exportées ───────────────────────────────────────────────

  describe('re-exported references', () => {
    test('databaseManager is the singleton from database-manager.js', () => {
      expect(databaseManager).toBe(mockDatabaseManager);
    });

    test('closeAllConnections is exported', () => {
      expect(typeof closeAllConnections).toBe('function');
    });
  });
});
