// Unit tests for MetadataLoader (src/loaders/metadata.js)
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

let createMetadataLoader;

beforeAll(async () => {
    ({ createMetadataLoader } = await import('../../src/loaders/metadata.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MetadataLoader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDatabaseManager.getPool.mockReturnValue(mockPool);
        mockDatabaseManager.getSchema.mockReturnValue('main');
        mockPool.acquire.mockResolvedValue(mockConnection);
    });

    describe('createMetadataLoader', () => {
        test('crée un DataLoader avec le bon databaseId', () => {
            const loader = createMetadataLoader('analytics');
            expect(loader).toBeDefined();
            expect(typeof loader.load).toBe('function');
            expect(typeof loader.clearAll).toBe('function');
        });

        test('crée un DataLoader sans databaseId (null par défaut)', () => {
            const loader = createMetadataLoader();
            expect(loader).toBeDefined();
        });
    });

    describe('loadSingle', () => {
        test('retourne les métadonnées pour un nom trouvé', async () => {
            const row = { name: 'age', type: 'integer', is_categorical: 0, is_primary_key: 0 };
            mockConnection.all.mockResolvedValue([row]);

            const loader = createMetadataLoader('main');
            const result = await loader.load('age');

            expect(result).toEqual({
                name: 'age',
                type: 'integer',
                is_categorical: false,
                is_primary_key: false
            });
        });

        test('retourne null quand le champ n\'est pas trouvé', async () => {
            mockConnection.all.mockResolvedValue([]);

            const loader = createMetadataLoader('main');
            const result = await loader.load('unknown_field');

            expect(result).toBeNull();
        });

        test('convertit is_categorical en booléen', async () => {
            mockConnection.all.mockResolvedValue([{
                name: 'country',
                type: 'string',
                is_categorical: 1,
                is_primary_key: 0
            }]);

            const loader = createMetadataLoader('main');
            const result = await loader.load('country');

            expect(result.is_categorical).toBe(true);
            expect(result.is_primary_key).toBe(false);
        });

        test('convertit is_primary_key en booléen', async () => {
            mockConnection.all.mockResolvedValue([{
                name: 'id',
                type: 'integer',
                is_categorical: 0,
                is_primary_key: 1
            }]);

            const loader = createMetadataLoader('main');
            const result = await loader.load('id');

            expect(result.is_categorical).toBe(false);
            expect(result.is_primary_key).toBe(true);
        });

        test('utilise qualifyTable pour la table metadata', async () => {
            mockConnection.all.mockResolvedValue([{ name: 'field', is_categorical: 0, is_primary_key: 0 }]);

            const loader = createMetadataLoader('mydb');
            await loader.load('field');

            const query = mockConnection.all.mock.calls[0][0];
            expect(query).toContain('"mydb"');
            expect(query).toContain('metadata');
        });
    });
});
