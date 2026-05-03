// Unit tests for DimensionLoader (src/loaders/dimension.js)
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

let createDimensionLoader, createDimensionValueLoader;

beforeAll(async () => {
    ({ createDimensionLoader, createDimensionValueLoader } = await import('../../../src/loaders/dimension.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DimensionLoader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDatabaseManager.getPool.mockReturnValue(mockPool);
        mockDatabaseManager.getSchema.mockReturnValue('main');
        mockPool.acquire.mockResolvedValue(mockConnection);
    });

    describe('createDimensionLoader', () => {
        test('crée un DataLoader valide', () => {
            const loader = createDimensionLoader('main');
            expect(loader).toBeDefined();
            expect(typeof loader.load).toBe('function');
        });

        test('fonctionne sans databaseId', () => {
            const loader = createDimensionLoader();
            expect(loader).toBeDefined();
        });
    });

    describe('loadSingle', () => {
        test('retourne les lignes de la table de dimension', async () => {
            const rows = [
                { value: '1', label: 'France' },
                { value: '2', label: 'Allemagne' }
            ];
            mockConnection.all.mockResolvedValue(rows);

            const loader = createDimensionLoader('main');
            const result = await loader.load('country');

            expect(result).toEqual(rows);
        });

        test('retourne un tableau vide si la table est vide', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createDimensionLoader('main');
            const result = await loader.load('country');

            expect(result).toEqual([]);
        });

        test('retourne un tableau vide en cas d\'erreur SQL', async () => {
            mockConnection.all.mockRejectedValue(new Error('Table does not exist'));

            const loader = createDimensionLoader('main');
            const result = await loader.load('nonexistent');

            expect(result).toEqual([]);
        });

        test('utilise qualifyTable avec le bon catalogue', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createDimensionLoader('mydb');
            await loader.load('region');

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('"mydb"');
            expect(query).toContain('dim_region');
        });
    });

    describe('createDimensionValueLoader', () => {
        test('crée un DataLoader valide pour les valeurs', () => {
            const loader = createDimensionValueLoader('main');
            expect(loader).toBeDefined();
            expect(typeof loader.load).toBe('function');
        });
    });

    describe('loadBatchValues', () => {
        test('résout les labels pour plusieurs dimensions en batch', async () => {
            mockConnection.all
                .mockResolvedValueOnce([
                    { value: '1', label: 'France' },
                    { value: '2', label: 'Allemagne' }
                ])
                .mockResolvedValueOnce([
                    { value: 'A', label: 'Actif' }
                ]);

            const loader = createDimensionValueLoader('main');
            const results = await loader.loadMany([
                { dimensionName: 'country', value: '1' },
                { dimensionName: 'country', value: '2' },
                { dimensionName: 'status', value: 'A' }
            ]);

            expect(results[0]).toEqual({ name: 'country', value: '1', label: 'France' });
            expect(results[1]).toEqual({ name: 'country', value: '2', label: 'Allemagne' });
            expect(results[2]).toEqual({ name: 'status', value: 'A', label: 'Actif' });
        });

        test('retourne la valeur brute si non trouvée dans la dimension', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createDimensionValueLoader('main');
            const results = await loader.loadMany([
                { dimensionName: 'country', value: 'unknown' }
            ]);

            expect(results[0]).toEqual({ name: 'country', value: 'unknown', label: 'unknown' });
        });

        test('retourne la valeur brute en cas d\'erreur SQL', async () => {
            mockConnection.all.mockRejectedValue(new Error('Table not found'));

            const loader = createDimensionValueLoader('main');
            const results = await loader.loadMany([
                { dimensionName: 'broken', value: 'x' }
            ]);

            expect(results[0]).toEqual({ name: 'broken', value: 'x', label: 'x' });
        });
    });
});
