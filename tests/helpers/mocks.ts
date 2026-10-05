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
      SELECT_OPTIONS_CACHE_TIMEOUT: number;
    };
    PAGINATION: {
      MAX_LIMIT: number;
      MAX_OFFSET: number;
    };
    TIMEOUTS: Record<
      | 'FACT_SIMPLE'
      | 'FACT_COMPLEX'
      | 'AGGREGATED_SIMPLE'
      | 'AGGREGATED_COMPLEX'
      | 'METADATA'
      | 'SELECT_OPTIONS'
      | 'CACHE_DEFAULT',
      number
    >;
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
  getDataVersion: jest.Mock;
}

// ─── Fabriques ─────────────────────────────────────────────────────────────────

/**
 * Create a minimal loader configuration object with default timeout and batch values.
 *
 * @returns A LoaderConfig object matching the shape expected by BaseLoader.
 */
export const makeLoaderConfig = (): LoaderConfig => ({
  API: {
    LOADERS: {
      DEFAULT_CACHE_TIMEOUT: 300000,
      BATCH_SIZE: 10,
      METADATA_CACHE_TIMEOUT: 600000,
      FACT_CACHE_TIMEOUT: 300000,
      SELECT_OPTIONS_CACHE_TIMEOUT: 600000,
    },
    PAGINATION: { MAX_LIMIT: 1000, MAX_OFFSET: 10000 },
    // Échéances des lots (queryTimeout des loaders)
    TIMEOUTS: {
      FACT_SIMPLE: 10000,
      FACT_COMPLEX: 15000,
      AGGREGATED_SIMPLE: 10000,
      AGGREGATED_COMPLEX: 15000,
      METADATA: 5000,
      SELECT_OPTIONS: 5000,
      CACHE_DEFAULT: 300,
    },
  },
});

/**
 * Create a mock pool exposing acquire and release as Jest mock functions.
 *
 * @returns A MockPool with jest.fn() for acquire and release.
 */
export const makePool = (): MockPool => ({
  acquire: jest.fn(),
  release: jest.fn(),
});

/**
 * Create a simple mock connection for loaders that only use the all() method.
 *
 * @returns A MockConnection with jest.fn() for all.
 */
export const makeConnection = (): MockConnection => ({
  all: jest.fn(),
});

/**
 * Create an extended mock connection for loaders using getAsJsonArray or getWithMetadata.
 *
 * @returns A MockExtendedConnection with jest.fn() for all, getAsJsonArray, and getWithMetadata.
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
 * @param pool - Optional MockPool to pre-wire as the return value of getPool.
 *
 * @returns A MockDatabaseManager with jest.fn() for the methods used by loaders and resolvers (pool access, default catalog/schema, schema allow-list, served data version).
 */
export const makeDatabaseManager = (pool: MockPool | null = null): MockDatabaseManager => ({
  getPool: pool ? jest.fn().mockReturnValue(pool) : jest.fn(),
  getDefaultCatalog: jest.fn().mockReturnValue('main'),
  getDefaultSchema: jest.fn().mockReturnValue('main'),
  getSchemas: jest.fn().mockReturnValue(['main']),
  isValidSchema: jest.fn().mockReturnValue(true),
  // Version des données servie : segment `@v1` des clés de cache
  getDataVersion: jest.fn().mockReturnValue('v1'),
});
