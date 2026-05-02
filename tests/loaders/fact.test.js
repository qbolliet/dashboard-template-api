// Unit tests for FactLoader (src/loaders/fact.js)
import { jest } from '@jest/globals';
import { makeLoaderConfig, makePool, makeExtendedConnection, makeDatabaseManager } from '../helpers/mocks.js';

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockPool = makePool();
const mockConnection = makeExtendedConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../src/db/index.js', () => ({ databaseManager: mockDatabaseManager }));
jest.unstable_mockModule('../../src/utils/cache.js', () => ({ withCache: jest.fn().mockImplementation(async (k, fn) => fn()) }));
jest.unstable_mockModule('../../src/utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({ config: mockConfig }));

// ─── Dynamic import ───────────────────────────────────────────────────────────

let createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader, FactLoader;

beforeAll(async () => {
    ({ createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader, FactLoader } =
        await import('../../src/loaders/fact.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FactLoader', () => {
    const baseParams = {
        fields: ['id', 'value'],
        filters: null,
        structuredFilters: null,
        limit: 10,
        offset: 0,
        sort: []
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockDatabaseManager.getPool.mockReturnValue(mockPool);
        mockDatabaseManager.getSchema.mockReturnValue('main');
        mockPool.acquire.mockResolvedValue(mockConnection);
    });

    describe('createFactLoader', () => {
        test('crée un DataLoader valide', () => {
            const loader = createFactLoader('main');
            expect(loader).toBeDefined();
            expect(typeof loader.load).toBe('function');
        });

        test('fonctionne sans databaseId', () => {
            const loader = createFactLoader();
            expect(loader).toBeDefined();
        });
    });

    describe('loadFacts - format default', () => {
        test('retourne un tableau de lignes', async () => {
            const rows = [{ id: 1, value: 100 }, { id: 2, value: 200 }];
            mockConnection.all.mockResolvedValue(rows);

            const loader = createFactLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(result).toEqual(rows);
        });

        test('inclut la clause WHERE pour les filtres textuels', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createFactLoader('main');
            await loader.load({ ...baseParams, filters: 'country = \'FR\'' });

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('WHERE');
            expect(query).toContain('country');
        });

        test('inclut ORDER BY pour le tri', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createFactLoader('main');
            await loader.load({ ...baseParams, sort: [{ field: 'value', order: 'DESC' }] });

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('ORDER BY value DESC');
        });

        test('inclut LIMIT et OFFSET', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createFactLoader('main');
            await loader.load({ ...baseParams, limit: 5, offset: 10 });

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('LIMIT 5');
            expect(query).toContain('OFFSET 10');
        });

        test('lève une erreur si limit dépasse MAX_LIMIT', async () => {
            const loader = createFactLoader('main');
            const result = await loader.load({ ...baseParams, limit: 9999 });
            // L'erreur est attrapée par createLoader et retourne null
            expect(result).toBeNull();
        });
    });

    describe('loadFacts - format json', () => {
        test('utilise getAsJsonArray pour le format json', async () => {
            mockConnection.getAsJsonArray.mockResolvedValue('[{"id":1}]');

            const loader = createFactLoader('main');
            const result = await loader.load({ ...baseParams, format: 'json' });

            expect(mockConnection.getAsJsonArray).toHaveBeenCalled();
            expect(result).toBe('[{"id":1}]');
        });
    });

    describe('loadFacts - format metadata', () => {
        test('utilise getWithMetadata pour le format metadata', async () => {
            const metaResult = { data: [{ id: 1 }], metadata: { columns: [] } };
            mockConnection.getWithMetadata.mockResolvedValue(metaResult);
            mockConnection.all.mockResolvedValue([{ total: 5 }]);

            const loader = createFactWithMetadataLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(mockConnection.getWithMetadata).toHaveBeenCalled();
        });
    });

    describe('createFactWithCountLoader', () => {
        test('retourne les données avec le comptage total', async () => {
            const rows = [{ id: 1, value: 100 }];
            mockConnection.all
                .mockResolvedValueOnce(rows)       // données
                .mockResolvedValueOnce([{ total: 42 }]); // count

            const loader = createFactWithCountLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(result).toHaveProperty('data');
            expect(result).toHaveProperty('total', 42);
            expect(result).toHaveProperty('hasNextPage');
            expect(result).toHaveProperty('currentPage');
            expect(result).toHaveProperty('totalPages');
        });

        test('calcule hasNextPage correctement', async () => {
            mockConnection.all
                .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
                .mockResolvedValueOnce([{ total: 20 }]);

            const loader = createFactWithCountLoader('main');
            const result = await loader.load({ ...baseParams, limit: 2, offset: 0 });

            expect(result.hasNextPage).toBe(true);
            expect(result.currentPage).toBe(1);
            expect(result.totalPages).toBe(10);
        });

        test('hasNextPage est false quand on est à la dernière page', async () => {
            mockConnection.all
                .mockResolvedValueOnce([{ id: 1 }])
                .mockResolvedValueOnce([{ total: 5 }]);

            const loader = createFactWithCountLoader('main');
            const result = await loader.load({ ...baseParams, limit: 10, offset: 0 });

            expect(result.hasNextPage).toBe(false);
        });
    });

    describe('qualifyTable', () => {
        test('utilise le bon catalogue dans la requête', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createFactLoader('mydb');
            await loader.load({ ...baseParams });

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('"mydb"');
            expect(query).toContain('fact_table');
        });
    });
});
