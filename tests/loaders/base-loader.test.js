// Unit tests for BaseQueryLoader and FactQueryLoader (src/loaders/base-loader.js)
// Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
import { jest } from '@jest/globals';

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockPool = {
    acquire: jest.fn(),
    release: jest.fn()
};

const mockConnection = {
    all: jest.fn(),
    getAsJsonArray: jest.fn(),
    getWithMetadata: jest.fn()
};

const mockDatabaseManager = {
    getPool: jest.fn().mockReturnValue(mockPool),
    defaultDatabase: 'main',
    getSchema: jest.fn().mockReturnValue('main')
};

const mockConfig = {
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
        PAGINATION: {
            MAX_LIMIT: 1000,
            MAX_OFFSET: 10000
        }
    }
};

const mockWithCache = jest.fn();
const mockLogger = {
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
};

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../src/db/index.js', () => ({
    databaseManager: mockDatabaseManager
}));

jest.unstable_mockModule('../../src/utils/cache.js', () => ({
    withCache: mockWithCache
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    logger: mockLogger
}));

jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({
    config: mockConfig
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let BaseQueryLoader, FactQueryLoader;

beforeAll(async () => {
    ({ BaseQueryLoader, FactQueryLoader } = await import('../../src/loaders/base-loader.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BaseQueryLoader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDatabaseManager.getPool.mockReturnValue(mockPool);
        mockDatabaseManager.getSchema.mockReturnValue('main');
        mockDatabaseManager.defaultDatabase = 'main';
        mockPool.acquire.mockResolvedValue(mockConnection);
    });

    describe('Constructor', () => {
        test('initialise avec la configuration par défaut', () => {
            const loader = new BaseQueryLoader();
            expect(loader.batchSize).toBe(5);
            expect(loader.cachePrefix).toBe('default');
            expect(loader.cacheEnabled).toBe(true);
            expect(loader.databaseId).toBeNull();
            expect(loader.cacheTimeout).toBe(300000);
        });

        test('initialise avec une configuration personnalisée', () => {
            const loader = new BaseQueryLoader({
                batchSize: 15,
                cachePrefix: 'custom',
                cache: false,
                databaseId: 'analytics',
                cacheTimeout: 99999
            });
            expect(loader.batchSize).toBe(15);
            expect(loader.cachePrefix).toBe('custom');
            expect(loader.cacheEnabled).toBe(false);
            expect(loader.databaseId).toBe('analytics');
            expect(loader.cacheTimeout).toBe(99999);
        });

        test('cache activé par défaut même si non spécifié', () => {
            const loader = new BaseQueryLoader({ cache: undefined });
            expect(loader.cacheEnabled).toBe(true);
        });

        test('cache désactivé quand cache: false', () => {
            const loader = new BaseQueryLoader({ cache: false });
            expect(loader.cacheEnabled).toBe(false);
        });
    });

    describe('executeWithConnection', () => {
        test('acquiert et libère la connexion correctement', async () => {
            const loader = new BaseQueryLoader({ databaseId: 'main' });
            const queryFn = jest.fn().mockResolvedValue('result');

            const result = await loader.executeWithConnection(queryFn);

            expect(mockDatabaseManager.getPool).toHaveBeenCalledWith('main');
            expect(mockPool.acquire).toHaveBeenCalled();
            expect(queryFn).toHaveBeenCalledWith(mockConnection);
            expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
            expect(result).toBe('result');
        });

        test('libère la connexion même en cas d\'erreur de la requête', async () => {
            const loader = new BaseQueryLoader();
            const queryFn = jest.fn().mockRejectedValue(new Error('Query failed'));

            await expect(loader.executeWithConnection(queryFn)).rejects.toThrow('Query failed');
            expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
        });

        test('ne libère pas la connexion si l\'acquisition échoue', async () => {
            const loader = new BaseQueryLoader();
            mockPool.acquire.mockRejectedValue(new Error('Pool exhausted'));
            const queryFn = jest.fn();

            await expect(loader.executeWithConnection(queryFn)).rejects.toThrow('Pool exhausted');
            expect(mockPool.release).not.toHaveBeenCalled();
            expect(queryFn).not.toHaveBeenCalled();
        });

        test('utilise null comme databaseId par défaut', async () => {
            const loader = new BaseQueryLoader({ databaseId: null });
            const queryFn = jest.fn().mockResolvedValue('result');

            await loader.executeWithConnection(queryFn);
            expect(mockDatabaseManager.getPool).toHaveBeenCalledWith(null);
        });

        test('gère plusieurs opérations concurrentes', async () => {
            const loader = new BaseQueryLoader();
            const ops = Array.from({ length: 5 }, (_, i) =>
                loader.executeWithConnection(async () => `result-${i}`)
            );

            const results = await Promise.all(ops);
            expect(results).toHaveLength(5);
            expect(mockPool.acquire).toHaveBeenCalledTimes(5);
            expect(mockPool.release).toHaveBeenCalledTimes(5);
        });
    });

    describe('qualifyTable', () => {
        test('utilise databaseId quand il est défini', () => {
            const loader = new BaseQueryLoader({ databaseId: 'mydb' });
            mockDatabaseManager.getSchema.mockReturnValue('main');

            const result = loader.qualifyTable('fact_table');
            expect(result).toBe('"mydb".main.fact_table');
            expect(mockDatabaseManager.getSchema).toHaveBeenCalledWith('mydb');
        });

        test('utilise defaultDatabase quand databaseId est null', () => {
            const loader = new BaseQueryLoader({ databaseId: null });
            mockDatabaseManager.defaultDatabase = 'defaultdb';
            mockDatabaseManager.getSchema.mockReturnValue('main');

            const result = loader.qualifyTable('metadata');
            expect(result).toBe('"defaultdb".main.metadata');
        });

        test('formate correctement les noms de tables avec les guillemets', () => {
            const loader = new BaseQueryLoader({ databaseId: 'catalog1' });
            mockDatabaseManager.getSchema.mockReturnValue('myschema');

            const result = loader.qualifyTable('dim_country');
            expect(result).toBe('"catalog1".myschema.dim_country');
        });
    });

    describe('loadWithCache', () => {
        test('appelle withCache quand le cache est activé', async () => {
            const loader = new BaseQueryLoader({ cachePrefix: 'test', databaseId: 'main' });
            const loaderFn = jest.fn().mockResolvedValue('result');
            mockWithCache.mockImplementation(async (key, fn) => await fn());

            const result = await loader.loadWithCache('mykey', loaderFn);

            expect(mockWithCache).toHaveBeenCalledWith(
                'test:main:"mykey"',
                loaderFn,
                loader.cacheTimeout
            );
            expect(result).toBe('result');
        });

        test('contourne le cache quand désactivé', async () => {
            const loader = new BaseQueryLoader({ cache: false });
            const loaderFn = jest.fn().mockResolvedValue('direct');

            const result = await loader.loadWithCache('key', loaderFn);

            expect(mockWithCache).not.toHaveBeenCalled();
            expect(loaderFn).toHaveBeenCalled();
            expect(result).toBe('direct');
        });

        test('fallback vers le chargement direct en cas d\'erreur cache', async () => {
            const loader = new BaseQueryLoader({ cache: true });
            mockWithCache.mockRejectedValue(new Error('Cache error'));
            const loaderFn = jest.fn().mockResolvedValue('fallback');

            const result = await loader.loadWithCache('key', loaderFn);

            expect(result).toBe('fallback');
            expect(loaderFn).toHaveBeenCalled();
        });

        test('génère la clé cache correcte pour un objet complexe', async () => {
            const loader = new BaseQueryLoader({ cachePrefix: 'test', databaseId: 'main' });
            const complexKey = { field: 'value', nested: { prop: 123 } };
            const loaderFn = jest.fn().mockResolvedValue('result');
            mockWithCache.mockImplementation(async (key, fn) => await fn());

            await loader.loadWithCache(complexKey, loaderFn);

            expect(mockWithCache).toHaveBeenCalledWith(
                `test:main:${JSON.stringify(complexKey)}`,
                loaderFn,
                loader.cacheTimeout
            );
        });

        test('utilise "default" dans la clé cache quand databaseId est null', async () => {
            const loader = new BaseQueryLoader({ cachePrefix: 'pre', databaseId: null });
            const loaderFn = jest.fn().mockResolvedValue('result');
            mockWithCache.mockImplementation(async (key, fn) => await fn());

            await loader.loadWithCache('k', loaderFn);

            expect(mockWithCache).toHaveBeenCalledWith(
                'pre:default:"k"',
                loaderFn,
                expect.any(Number)
            );
        });

        test('fait le fallback si JSON.stringify échoue (référence circulaire)', async () => {
            const loader = new BaseQueryLoader({ cache: true });
            const circularKey = {};
            circularKey.self = circularKey;
            const loaderFn = jest.fn().mockResolvedValue('result');

            // JSON.stringify throws → caught → fallback to direct loader
            const result = await loader.loadWithCache(circularKey, loaderFn);
            expect(result).toBe('result');
            expect(loaderFn).toHaveBeenCalled();
        });
    });
});

describe('FactQueryLoader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('buildSelectClause', () => {
        test('retourne * pour un tableau vide', () => {
            const loader = new FactQueryLoader();
            expect(loader.buildSelectClause([])).toBe('*');
        });

        test('retourne * pour null', () => {
            const loader = new FactQueryLoader();
            expect(loader.buildSelectClause(null)).toBe('*');
        });

        test('joint les champs par virgule', () => {
            const loader = new FactQueryLoader();
            expect(loader.buildSelectClause(['id', 'name', 'value'])).toBe('id, name, value');
        });

        test('gère un seul champ', () => {
            const loader = new FactQueryLoader();
            expect(loader.buildSelectClause(['id'])).toBe('id');
        });
    });

    describe('buildSortClause', () => {
        test('retourne une chaîne vide pour un tri vide', () => {
            const loader = new FactQueryLoader();
            expect(loader.buildSortClause([])).toBe('');
        });

        test('retourne une chaîne vide pour null', () => {
            const loader = new FactQueryLoader();
            expect(loader.buildSortClause(null)).toBe('');
        });

        test('construit la clause ORDER BY', () => {
            const loader = new FactQueryLoader();
            const result = loader.buildSortClause([
                { field: 'name', order: 'ASC' },
                { field: 'value', order: 'DESC' }
            ]);
            expect(result).toBe('ORDER BY name ASC, value DESC');
        });

        test('gère un seul critère de tri', () => {
            const loader = new FactQueryLoader();
            expect(loader.buildSortClause([{ field: 'id', order: 'ASC' }])).toBe('ORDER BY id ASC');
        });
    });

    describe('validatePagination', () => {
        test('lève une erreur si limit dépasse MAX_LIMIT', () => {
            const loader = new FactQueryLoader();
            expect(() => loader.validatePagination(1001, 0)).toThrow('Limit cannot exceed 1000');
        });

        test('lève une erreur si offset dépasse MAX_OFFSET', () => {
            const loader = new FactQueryLoader();
            expect(() => loader.validatePagination(10, 10001)).toThrow('Offset cannot exceed 10000');
        });

        test('ne lève pas d\'erreur pour une pagination valide', () => {
            const loader = new FactQueryLoader();
            expect(() => loader.validatePagination(100, 1000)).not.toThrow();
        });

        test('ne lève pas d\'erreur aux valeurs limites exactes', () => {
            const loader = new FactQueryLoader();
            expect(() => loader.validatePagination(1000, 10000)).not.toThrow();
        });
    });
});
