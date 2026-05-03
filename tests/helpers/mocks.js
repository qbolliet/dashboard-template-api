// Shared mock factories for loader unit tests.
import { jest } from '@jest/globals';

export const makeLoaderConfig = () => ({
    API: {
        LOADERS: {
            DEFAULT_CACHE_TIMEOUT: 300000,
            BATCH_SIZE: 10,
            METADATA_CACHE_TIMEOUT: 600000,
            FACT_CACHE_TIMEOUT: 300000,
            DIMENSION_CACHE_TIMEOUT: 600000,
            SELECT_OPTIONS_CACHE_TIMEOUT: 600000,
            MAX_BATCH_SIZE: 50
        },
        PAGINATION: { MAX_LIMIT: 1000, MAX_OFFSET: 10000 }
    }
});

export const makePool = () => ({
    acquire: jest.fn(),
    release: jest.fn()
});

// Simple connection for loaders that only use .all()
export const makeConnection = () => ({
    all: jest.fn()
});

// Extended connection for loaders that also use getAsJsonArray / getWithMetadata
export const makeExtendedConnection = () => ({
    all: jest.fn(),
    getAsJsonArray: jest.fn(),
    getWithMetadata: jest.fn()
});

// Pass a pool to pre-wire getPool's return value; omit for index.test.js where
// getPool is reset in beforeEach with specific per-test return values.
export const makeDatabaseManager = (pool = null) => ({
    getPool: pool ? jest.fn().mockReturnValue(pool) : jest.fn(),
    defaultDatabase: 'main',
    getSchema: jest.fn().mockReturnValue('main')
});
