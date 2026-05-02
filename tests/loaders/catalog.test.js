// Unit tests for CatalogMetadataLoader and CatalogDimensionNamesLoader (src/loaders/catalog.js)
import { jest } from '@jest/globals';
import { makeLoaderConfig, makePool, makeConnection, makeDatabaseManager } from '../helpers/mocks.js';

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockPool = makePool();
const mockConnection = makeConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../src/db/index.js', () => ({ databaseManager: mockDatabaseManager }));
jest.unstable_mockModule('../../src/utils/cache.js', () => ({ withCache: jest.fn().mockImplementation(async (k, fn) => fn()) }));
jest.unstable_mockModule('../../src/utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({ config: mockConfig }));

// ─── Dynamic import ───────────────────────────────────────────────────────────

let createCatalogMetadataLoader, createCatalogDimensionNamesLoader;

beforeAll(async () => {
    ({ createCatalogMetadataLoader, createCatalogDimensionNamesLoader } =
        await import('../../src/loaders/catalog.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CatalogMetadataLoader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDatabaseManager.getPool.mockReturnValue(mockPool);
        mockDatabaseManager.getSchema.mockReturnValue('main');
        mockPool.acquire.mockResolvedValue(mockConnection);
    });

    describe('createCatalogMetadataLoader', () => {
        test('crée un DataLoader valide', () => {
            const loader = createCatalogMetadataLoader();
            expect(loader).toBeDefined();
            expect(typeof loader.load).toBe('function');
        });
    });

    describe('loadAllMetadata', () => {
        test('charge toutes les métadonnées pour un catalogue', async () => {
            mockConnection.all.mockResolvedValue([
                { name: 'age', type: 'integer', is_categorical: 0 },
                { name: 'country', type: 'string', is_categorical: 1 }
            ]);

            const loader = createCatalogMetadataLoader();
            const result = await loader.load('catalog1');

            expect(result).toHaveLength(2);
            expect(result[0].is_categorical).toBe(false);
            expect(result[1].is_categorical).toBe(true);
        });

        test('convertit is_categorical en booléen', async () => {
            mockConnection.all.mockResolvedValue([
                { name: 'status', is_categorical: 1 },
                { name: 'score', is_categorical: 0 }
            ]);

            const loader = createCatalogMetadataLoader();
            const result = await loader.load('mydb');

            expect(result[0].is_categorical).toBe(true);
            expect(result[1].is_categorical).toBe(false);
        });

        test('utilise le bon catalogue dans la requête SQL', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createCatalogMetadataLoader();
            await loader.load('catalog_abc');

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('"catalog_abc"');
            expect(query).toContain('metadata');
        });

        test('appelle getSchema avec l\'id du catalogue', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createCatalogMetadataLoader();
            await loader.load('mydb');

            expect(mockDatabaseManager.getSchema).toHaveBeenCalledWith('mydb');
        });

        test('retourne un tableau vide si aucune métadonnée', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createCatalogMetadataLoader();
            const result = await loader.load('empty_catalog');

            expect(result).toEqual([]);
        });
    });
});

describe('CatalogDimensionNamesLoader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDatabaseManager.getPool.mockReturnValue(mockPool);
        mockDatabaseManager.getSchema.mockReturnValue('main');
        mockPool.acquire.mockResolvedValue(mockConnection);
    });

    describe('createCatalogDimensionNamesLoader', () => {
        test('crée un DataLoader valide', () => {
            const loader = createCatalogDimensionNamesLoader();
            expect(loader).toBeDefined();
            expect(typeof loader.load).toBe('function');
        });
    });

    describe('loadDimensionNames', () => {
        test('retourne les noms des champs catégoriels', async () => {
            mockConnection.all.mockResolvedValue([
                { name: 'country' },
                { name: 'status' }
            ]);

            const loader = createCatalogDimensionNamesLoader();
            const result = await loader.load('catalog1');

            expect(result).toEqual(['country', 'status']);
        });

        test('filtre par is_categorical = true dans la requête', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createCatalogDimensionNamesLoader();
            await loader.load('mydb');

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('is_categorical');
            expect(query).toContain('true');
        });

        test('utilise le bon catalogue dans la requête SQL', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createCatalogDimensionNamesLoader();
            await loader.load('target_db');

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('"target_db"');
        });

        test('retourne un tableau vide si aucun champ catégoriel', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createCatalogDimensionNamesLoader();
            const result = await loader.load('catalog_no_dims');

            expect(result).toEqual([]);
        });
    });
});
