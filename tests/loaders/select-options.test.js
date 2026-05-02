// Unit tests for SelectOptionsLoader (src/loaders/select-options.js)
import { jest } from '@jest/globals';

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockPool = { acquire: jest.fn(), release: jest.fn() };
const mockConnection = { all: jest.fn() };
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
        PAGINATION: { MAX_LIMIT: 1000, MAX_OFFSET: 10000 }
    }
};

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../src/db/index.js', () => ({ databaseManager: mockDatabaseManager }));
jest.unstable_mockModule('../../src/utils/cache.js', () => ({ withCache: jest.fn().mockImplementation(async (k, fn) => fn()) }));
jest.unstable_mockModule('../../src/utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({ config: mockConfig }));

// ─── Dynamic import ───────────────────────────────────────────────────────────

let createSelectOptionsLoader;

beforeAll(async () => {
    ({ createSelectOptionsLoader } = await import('../../src/loaders/select-options.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SelectOptionsLoader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDatabaseManager.getPool.mockReturnValue(mockPool);
        mockDatabaseManager.getSchema.mockReturnValue('main');
        mockPool.acquire.mockResolvedValue(mockConnection);
    });

    describe('createSelectOptionsLoader', () => {
        test('crée un DataLoader valide', () => {
            const loader = createSelectOptionsLoader('main');
            expect(loader).toBeDefined();
            expect(typeof loader.load).toBe('function');
        });

        test('fonctionne sans databaseId', () => {
            const loader = createSelectOptionsLoader();
            expect(loader).toBeDefined();
        });
    });

    describe('loadSelectOptions - champ catégoriel', () => {
        test('charge depuis la table de dimension pour un champ catégoriel', async () => {
            mockConnection.all
                .mockResolvedValueOnce([{ is_categorical: 1 }])   // metadata
                .mockResolvedValueOnce([                           // dimension
                    { value: '1', label: 'France' },
                    { value: '2', label: 'Allemagne' }
                ]);

            const loader = createSelectOptionsLoader('main');
            const result = await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

            expect(result).toEqual([
                { value: '1', label: 'France' },
                { value: '2', label: 'Allemagne' }
            ]);
            const dimQuery = mockConnection.all.mock.calls[1][0];
            expect(dimQuery).toContain('dim_country');
        });

        test('filtre par searchTerm dans la dimension', async () => {
            mockConnection.all
                .mockResolvedValueOnce([{ is_categorical: 1 }])
                .mockResolvedValueOnce([{ value: '1', label: 'France' }]);

            const loader = createSelectOptionsLoader('main');
            await loader.load({ fieldName: 'country', limit: 50, searchTerm: 'fra' });

            const dimQuery = mockConnection.all.mock.calls[1][0];
            expect(dimQuery).toContain('LIKE');
            expect(mockConnection.all.mock.calls[1][1]).toContain('%fra%');
        });
    });

    describe('loadSelectOptions - champ non catégoriel', () => {
        test('charge les valeurs distinctes depuis la table des faits', async () => {
            mockConnection.all
                .mockResolvedValueOnce([{ is_categorical: 0 }])   // metadata
                .mockResolvedValueOnce([                           // fact_table
                    { value: '100' },
                    { value: '200' }
                ]);

            const loader = createSelectOptionsLoader('main');
            const result = await loader.load({ fieldName: 'amount', limit: 50, searchTerm: null });

            expect(result).toEqual([
                { value: '100', label: '100' },
                { value: '200', label: '200' }
            ]);
            const factQuery = mockConnection.all.mock.calls[1][0];
            expect(factQuery).toContain('DISTINCT');
            expect(factQuery).toContain('fact_table');
        });

        test('filtre par searchTerm dans les faits', async () => {
            mockConnection.all
                .mockResolvedValueOnce([{ is_categorical: 0 }])
                .mockResolvedValueOnce([]);

            const loader = createSelectOptionsLoader('main');
            await loader.load({ fieldName: 'amount', limit: 50, searchTerm: '10' });

            const factQuery = mockConnection.all.mock.calls[1][0];
            expect(factQuery).toContain('LIKE');
            expect(mockConnection.all.mock.calls[1][1]).toContain('%10%');
        });
    });

    describe('loadSelectOptions - cas d\'erreur', () => {
        test('retourne un tableau vide si le champ est introuvable en metadata', async () => {
            mockConnection.all.mockResolvedValueOnce([]);

            const loader = createSelectOptionsLoader('main');
            const result = await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

            // is_categorical est undefined → traité comme non catégoriel
            expect(Array.isArray(result)).toBe(true);
        });

        test('retourne un tableau vide en cas d\'erreur SQL', async () => {
            mockConnection.all.mockRejectedValue(new Error('DB error'));

            const loader = createSelectOptionsLoader('main');
            const result = await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

            expect(result).toEqual([]);
        });

        test('lève une erreur pour un nom de champ invalide', async () => {
            const loader = createSelectOptionsLoader('main');
            const result = await loader.load({ fieldName: 'bad field!', limit: 50, searchTerm: null });
            // validateIdentifier lance une erreur, attrapée → tableau vide
            expect(result).toEqual([]);
        });
    });

    describe('string conversion des valeurs', () => {
        test('convertit toutes les valeurs en chaînes', async () => {
            mockConnection.all
                .mockResolvedValueOnce([{ is_categorical: 1 }])
                .mockResolvedValueOnce([{ value: 42, label: 'Quarante-deux' }]);

            const loader = createSelectOptionsLoader('main');
            const result = await loader.load({ fieldName: 'rank', limit: 10, searchTerm: null });

            expect(result[0].value).toBe('42');
        });
    });
});
