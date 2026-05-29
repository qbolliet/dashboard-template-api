/**
 * Shared mock factories for loader and resolver unit tests.
 *
 * Centralises the creation of typed Jest mocks for the database layer
 * (connections, pools, database managers) and the loader configuration
 * object, so individual test files don't repeat boilerplate setup code.
 */

// Fabrique de mocks partagés — évite la duplication de code dans les tests unitaires.
import { jest } from '@jest/globals';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Structure de configuration minimale des loaders, extraite de la config globale. */
interface LoaderConfig {
  API: {
    LOADERS: {
      DEFAULT_CACHE_TIMEOUT: number;
      BATCH_SIZE: number;
      METADATA_CACHE_TIMEOUT: number;
      FACT_CACHE_TIMEOUT: number;
      DIMENSION_CACHE_TIMEOUT: number;
      SELECT_OPTIONS_CACHE_TIMEOUT: number;
      MAX_BATCH_SIZE: number;
    };
    PAGINATION: {
      MAX_LIMIT: number;
      MAX_OFFSET: number;
    };
  };
}

/** Interface minimale d'une connexion DuckDB utilisée par les loaders. */
interface MockConnection {
  all: jest.Mock;
}

/** Interface étendue d'une connexion DuckDB — méthodes supplémentaires pour certains loaders. */
interface MockExtendedConnection {
  all: jest.Mock;
  getAsJsonArray: jest.Mock;
  getWithMetadata: jest.Mock;
}

/** Interface d'un pool de connexions DuckDB mocké. */
interface MockPool {
  acquire: jest.Mock;
  release: jest.Mock;
}

/** Interface minimale d'un DatabaseManager mocké utilisé dans les tests. */
interface MockDatabaseManager {
  getPool: jest.Mock;
  getDefaultCatalog: jest.Mock;
  getDefaultSchema: jest.Mock;
  getSchemas: jest.Mock;
  isValidSchema: jest.Mock;
}

// ─── Fabriques ─────────────────────────────────────────────────────────────────

/**
 * Create a minimal loader configuration object with default timeout and batch values.
 *
 * Returns:
 *     A LoaderConfig object matching the shape expected by BaseLoader.
 */
export const makeLoaderConfig = (): LoaderConfig => ({
  API: {
    LOADERS: {
      DEFAULT_CACHE_TIMEOUT: 300000,
      BATCH_SIZE: 10,
      METADATA_CACHE_TIMEOUT: 600000,
      FACT_CACHE_TIMEOUT: 300000,
      DIMENSION_CACHE_TIMEOUT: 600000,
      SELECT_OPTIONS_CACHE_TIMEOUT: 600000,
      MAX_BATCH_SIZE: 50,
    },
    PAGINATION: { MAX_LIMIT: 1000, MAX_OFFSET: 10000 },
  },
});

/**
 * Create a mock pool exposing acquire and release as Jest mock functions.
 *
 * Returns:
 *     A MockPool with jest.fn() for acquire and release.
 */
export const makePool = (): MockPool => ({
  acquire: jest.fn(),
  release: jest.fn(),
});

/**
 * Create a simple mock connection for loaders that only use the all() method.
 *
 * Returns:
 *     A MockConnection with jest.fn() for all.
 */
export const makeConnection = (): MockConnection => ({
  all: jest.fn(),
});

/**
 * Create an extended mock connection for loaders using getAsJsonArray or getWithMetadata.
 *
 * Returns:
 *     A MockExtendedConnection with jest.fn() for all, getAsJsonArray, and getWithMetadata.
 */
export const makeExtendedConnection = (): MockExtendedConnection => ({
  all: jest.fn(),
  getAsJsonArray: jest.fn(),
  getWithMetadata: jest.fn(),
});

/**
 * Create a mock DatabaseManager with optional pre-wired pool.
 *
 * Pass a pool to pre-wire getPool's return value; omit for index.test.ts where
 * getPool is reset in beforeEach with specific per-test return values.
 *
 * Args:
 *     pool: Optional MockPool to pre-wire as the return value of getPool.
 *
 * Returns:
 *     A MockDatabaseManager with jest.fn() for the methods used by loaders
 *     and resolvers (pool access, default catalog/schema, schema allow-list).
 */
export const makeDatabaseManager = (pool: MockPool | null = null): MockDatabaseManager => ({
  getPool: pool ? jest.fn().mockReturnValue(pool) : jest.fn(),
  getDefaultCatalog: jest.fn().mockReturnValue('main'),
  getDefaultSchema: jest.fn().mockReturnValue('main'),
  getSchemas: jest.fn().mockReturnValue(['main']),
  isValidSchema: jest.fn().mockReturnValue(true),
});
