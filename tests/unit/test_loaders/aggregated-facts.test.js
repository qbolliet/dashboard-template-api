// Unit tests for AggregatedFactsLoader (src/loaders/aggregated-facts.js)
import { jest } from '@jest/globals';
import { makeLoaderConfig, makePool, makeConnection, makeDatabaseManager } from '../../helpers/mocks.js';

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockPool = makePool();
const mockConnection = makeConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/index.js', () => ({ databaseManager: mockDatabaseManager }));
jest.unstable_mockModule('../../../src/utils/cache.js', () => ({ withCache: jest.fn().mockImplementation(async (k, fn) => fn()) }));
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({ config: mockConfig }));

// ─── Dynamic import ───────────────────────────────────────────────────────────

let createAggregatedFactsLoader, createAggregatedFactsWithMetadataLoader,
    createAggregatedFactsWithCountLoader, AggregatedFactsLoader;

beforeAll(async () => {
    ({
        createAggregatedFactsLoader,
        createAggregatedFactsWithMetadataLoader,
        createAggregatedFactsWithCountLoader,
        AggregatedFactsLoader
    } = await import('../../../src/loaders/aggregated-facts.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AggregatedFactsLoader', () => {
    const baseParams = {
        fields: null,
        filters: null,
        structuredFilters: null,
        groupBy: 'country',
        aggregation: 'SUM',
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

    describe('AGGREGATION_MAP', () => {
        test('contient toutes les fonctions d\'agrégation', () => {
            expect(AggregatedFactsLoader.AGGREGATION_MAP).toMatchObject({
                SUM: 'SUM',
                AVG: 'AVG',
                MAX: 'MAX',
                MIN: 'MIN',
                COUNT: 'COUNT'
            });
        });

        test('inclut MEDIAN et MODE', () => {
            expect(AggregatedFactsLoader.AGGREGATION_MAP.MEDIAN).toBeDefined();
            expect(AggregatedFactsLoader.AGGREGATION_MAP.MODE).toBeDefined();
        });
    });

    describe('createAggregatedFactsLoader', () => {
        test('crée un DataLoader valide', () => {
            const loader = createAggregatedFactsLoader('main');
            expect(loader).toBeDefined();
            expect(typeof loader.load).toBe('function');
        });
    });

    describe('loadAggregatedFacts - format default', () => {
        test('retourne un tableau de résultats agrégés', async () => {
            mockConnection.all.mockResolvedValue([
                { key: 'FR', aggregatedValue: 500, count: 10 },
                { key: 'DE', aggregatedValue: 300, count: 5 }
            ]);

            const loader = createAggregatedFactsLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({
                key: 'FR',
                aggregatedValue: 500,
                count: 10,
                _groupByField: 'country'
            });
        });

        test('convertit les valeurs en nombres', async () => {
            mockConnection.all.mockResolvedValue([
                { key: '1', aggregatedValue: '42.5', count: '3' }
            ]);

            const loader = createAggregatedFactsLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(typeof result[0].aggregatedValue).toBe('number');
            expect(typeof result[0].count).toBe('number');
            expect(result[0].aggregatedValue).toBe(42.5);
        });

        test('convertit les clés en chaînes', async () => {
            mockConnection.all.mockResolvedValue([
                { key: 42, aggregatedValue: 100, count: 1 }
            ]);

            const loader = createAggregatedFactsLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(result[0].key).toBe('42');
        });

        test('inclut la fonction d\'agrégation correcte dans la requête', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createAggregatedFactsLoader('main');
            await loader.load({ ...baseParams, aggregation: 'AVG' });

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('AVG(value)');
        });

        test('utilise SUM par défaut pour une agrégation inconnue', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createAggregatedFactsLoader('main');
            await loader.load({ ...baseParams, aggregation: 'UNKNOWN' });

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('SUM(value)');
        });

        test('inclut LIMIT et OFFSET', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createAggregatedFactsLoader('main');
            await loader.load({ ...baseParams, limit: 5, offset: 10 });

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('LIMIT 5');
            expect(query).toContain('OFFSET 10');
        });
    });

    describe('createAggregatedFactsWithCountLoader', () => {
        test('retourne les données avec le comptage des groupes', async () => {
            mockConnection.all
                .mockResolvedValueOnce([
                    { key: 'FR', aggregatedValue: 500, count: 10 }
                ])
                .mockResolvedValueOnce([{ totalGroups: 25 }]);

            const loader = createAggregatedFactsWithCountLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(result).toHaveProperty('data');
            expect(result).toHaveProperty('totalGroups', 25);
            expect(result).toHaveProperty('hasNextPage', true);
            expect(result).toHaveProperty('currentPage', 1);
            expect(result).toHaveProperty('totalPages', 3);
        });
    });

    describe('createAggregatedFactsWithMetadataLoader', () => {
        test('retourne les données avec les métadonnées', async () => {
            mockConnection.all
                .mockResolvedValueOnce([
                    { key: 'FR', aggregatedValue: 500, count: 10 }
                ])
                .mockResolvedValueOnce([{ name: 'country', type: 'string', is_categorical: 1 }]);

            const loader = createAggregatedFactsWithMetadataLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(result).toHaveProperty('data');
            expect(result).toHaveProperty('metadata');
            expect(result.metadata).toHaveProperty('count', 1);
            expect(result.metadata).toHaveProperty('valueExtent');
            expect(result.metadata).toHaveProperty('statistics');
        });

        test('retourne des métadonnées vides pour un résultat vide', async () => {
            mockConnection.all
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const loader = createAggregatedFactsWithMetadataLoader('main');
            const result = await loader.load({ ...baseParams });

            expect(result.metadata.count).toBe(0);
            expect(result.metadata.keyExtent).toBeNull();
        });
    });

    describe('calculateStatistics', () => {
        let loaderInstance;

        beforeEach(() => {
            loaderInstance = new AggregatedFactsLoader('main');
        });

        test('retourne des nulls pour un tableau vide', () => {
            const stats = loaderInstance.calculateStatistics([]);
            expect(stats).toEqual({ mean: null, median: null, stdDev: null, quartiles: null });
        });

        test('calcule la moyenne correctement', () => {
            const stats = loaderInstance.calculateStatistics([2, 4, 6]);
            expect(stats.mean).toBe(4);
        });

        test('calcule la médiane pour un nombre impair de valeurs', () => {
            const stats = loaderInstance.calculateStatistics([1, 3, 5]);
            expect(stats.median).toBe(3);
        });

        test('calcule la médiane pour un nombre pair de valeurs', () => {
            const stats = loaderInstance.calculateStatistics([1, 2, 3, 4]);
            expect(stats.median).toBe(2.5);
        });

        test('calcule l\'écart-type', () => {
            const stats = loaderInstance.calculateStatistics([2, 4, 6]);
            expect(stats.stdDev).toBeCloseTo(1.633, 2);
        });

        test('retourne les quartiles', () => {
            const stats = loaderInstance.calculateStatistics([1, 2, 3, 4, 5, 6, 7, 8]);
            expect(stats.quartiles).toHaveLength(5);
            expect(stats.quartiles[0]).toBe(1); // min
            expect(stats.quartiles[4]).toBe(8); // max
        });

        test('gère une valeur unique', () => {
            const stats = loaderInstance.calculateStatistics([42]);
            expect(stats.mean).toBe(42);
            expect(stats.median).toBe(42);
            expect(stats.stdDev).toBe(0);
        });
    });
});
