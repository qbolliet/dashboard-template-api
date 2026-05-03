// Unit tests for createLoaders and createLoadersForRequest (src/loaders/index.js)
import { jest } from '@jest/globals';
import { makeLoaderConfig, makeDatabaseManager } from '../../helpers/mocks.js';

// ─── Fabrique de mock loader unique par appel ─────────────────────────────────

const makeMockLoader = () => ({
    load: jest.fn(),
    loadMany: jest.fn(),
    clear: jest.fn(),
    clearAll: jest.fn(),
    prime: jest.fn()
});

// ─── Config mock ──────────────────────────────────────────────────────────────

const mockConfig = makeLoaderConfig();
const mockDatabaseManager = makeDatabaseManager();

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({ config: mockConfig }));
jest.unstable_mockModule('../../../src/db/index.js', () => ({ databaseManager: mockDatabaseManager }));
jest.unstable_mockModule('../../../src/utils/cache.js', () => ({ withCache: jest.fn() }));
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() }
}));

// Chaque factory retourne une instance unique avec ses propres jest.fn()
jest.unstable_mockModule('../../../src/loaders/metadata.js', () => ({
    createMetadataLoader: jest.fn(() => makeMockLoader())
}));

jest.unstable_mockModule('../../../src/loaders/dimension.js', () => ({
    createDimensionLoader: jest.fn(() => makeMockLoader()),
    createDimensionValueLoader: jest.fn(() => makeMockLoader())
}));

jest.unstable_mockModule('../../../src/loaders/fact.js', () => ({
    createFactLoader: jest.fn(() => makeMockLoader()),
    createFactWithCountLoader: jest.fn(() => makeMockLoader()),
    createFactWithMetadataLoader: jest.fn(() => makeMockLoader())
}));

jest.unstable_mockModule('../../../src/loaders/aggregated-facts.js', () => ({
    createAggregatedFactsLoader: jest.fn(() => makeMockLoader()),
    createAggregatedFactsWithMetadataLoader: jest.fn(() => makeMockLoader()),
    createAggregatedFactsWithCountLoader: jest.fn(() => makeMockLoader())
}));

jest.unstable_mockModule('../../../src/loaders/select-options.js', () => ({
    createSelectOptionsLoader: jest.fn(() => makeMockLoader())
}));

jest.unstable_mockModule('../../../src/loaders/catalog.js', () => ({
    createCatalogMetadataLoader: jest.fn(() => makeMockLoader()),
    createCatalogDimensionNamesLoader: jest.fn(() => makeMockLoader())
}));

jest.unstable_mockModule('../../../src/loaders/cross-database.js', () => ({
    createCompareFacts: jest.fn(() => makeMockLoader()),
    createCompareAggregatedFacts: jest.fn(() => makeMockLoader()),
    createCrossDatabaseSelectOptions: jest.fn(() => makeMockLoader())
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let createLoaders, createLoadersForRequest;
let createMetadataLoader, createDimensionLoader, createDimensionValueLoader;
let createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader;
let createAggregatedFactsLoader, createAggregatedFactsWithMetadataLoader, createAggregatedFactsWithCountLoader;
let createSelectOptionsLoader;
let createCatalogMetadataLoader, createCatalogDimensionNamesLoader;
let createCompareFacts, createCompareAggregatedFacts, createCrossDatabaseSelectOptions;

beforeAll(async () => {
    ({ createLoaders, createLoadersForRequest } = await import('../../../src/loaders/index.js'));
    ({ createMetadataLoader } = await import('../../../src/loaders/metadata.js'));
    ({ createDimensionLoader, createDimensionValueLoader } = await import('../../../src/loaders/dimension.js'));
    ({ createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader } = await import('../../../src/loaders/fact.js'));
    ({
        createAggregatedFactsLoader,
        createAggregatedFactsWithMetadataLoader,
        createAggregatedFactsWithCountLoader
    } = await import('../../../src/loaders/aggregated-facts.js'));
    ({ createSelectOptionsLoader } = await import('../../../src/loaders/select-options.js'));
    ({ createCatalogMetadataLoader, createCatalogDimensionNamesLoader } = await import('../../../src/loaders/catalog.js'));
    ({ createCompareFacts, createCompareAggregatedFacts, createCrossDatabaseSelectOptions } =
        await import('../../../src/loaders/cross-database.js'));
});

// Clés de tous les loaders dans l'objet retourné par createLoaders
const ALL_LOADER_KEYS = [
    'metadata', 'dimension', 'dimensionValue',
    'fact', 'factWithCount', 'factWithMetadata',
    'aggregatedFacts', 'aggregatedFactsWithMetadata', 'aggregatedFactsWithCount',
    'selectOptions',
    'catalogMetadata', 'catalogDimensionNames',
    'compareFacts', 'compareAggregatedFacts', 'crossDatabaseSelectOptions'
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createLoaders', () => {
    describe('structure de l\'objet retourné', () => {
        test('contient tous les loaders standard', () => {
            const loaders = createLoaders();
            expect(loaders).toHaveProperty('metadata');
            expect(loaders).toHaveProperty('dimension');
            expect(loaders).toHaveProperty('dimensionValue');
            expect(loaders).toHaveProperty('fact');
            expect(loaders).toHaveProperty('factWithCount');
            expect(loaders).toHaveProperty('factWithMetadata');
            expect(loaders).toHaveProperty('aggregatedFacts');
            expect(loaders).toHaveProperty('aggregatedFactsWithMetadata');
            expect(loaders).toHaveProperty('aggregatedFactsWithCount');
            expect(loaders).toHaveProperty('selectOptions');
        });

        test('contient les loaders catalog', () => {
            const loaders = createLoaders();
            expect(loaders).toHaveProperty('catalogMetadata');
            expect(loaders).toHaveProperty('catalogDimensionNames');
        });

        test('contient les loaders cross-database', () => {
            const loaders = createLoaders();
            expect(loaders).toHaveProperty('compareFacts');
            expect(loaders).toHaveProperty('compareAggregatedFacts');
            expect(loaders).toHaveProperty('crossDatabaseSelectOptions');
        });

        test('expose les méthodes clearAll et prime', () => {
            const loaders = createLoaders();
            expect(typeof loaders.clearAll).toBe('function');
            expect(typeof loaders.prime).toBe('function');
        });
    });

    describe('transmission du databaseId', () => {
        test('passe le databaseId à tous les loaders spécifiques à une base', () => {
            const databaseId = 'analytics';
            createLoaders(databaseId);

            expect(createMetadataLoader).toHaveBeenCalledWith(databaseId);
            expect(createDimensionLoader).toHaveBeenCalledWith(databaseId);
            expect(createDimensionValueLoader).toHaveBeenCalledWith(databaseId);
            expect(createFactLoader).toHaveBeenCalledWith(databaseId);
            expect(createFactWithCountLoader).toHaveBeenCalledWith(databaseId);
            expect(createFactWithMetadataLoader).toHaveBeenCalledWith(databaseId);
            expect(createAggregatedFactsLoader).toHaveBeenCalledWith(databaseId);
            expect(createAggregatedFactsWithMetadataLoader).toHaveBeenCalledWith(databaseId);
            expect(createAggregatedFactsWithCountLoader).toHaveBeenCalledWith(databaseId);
            expect(createSelectOptionsLoader).toHaveBeenCalledWith(databaseId);
        });

        test('les loaders catalog et cross-database sont créés sans argument', () => {
            createLoaders('analytics');
            expect(createCatalogMetadataLoader).toHaveBeenCalledWith();
            expect(createCatalogDimensionNamesLoader).toHaveBeenCalledWith();
            expect(createCompareFacts).toHaveBeenCalledWith();
            expect(createCompareAggregatedFacts).toHaveBeenCalledWith();
            expect(createCrossDatabaseSelectOptions).toHaveBeenCalledWith();
        });

        test('utilise null par défaut si aucun databaseId fourni', () => {
            createLoaders();
            expect(createMetadataLoader).toHaveBeenCalledWith(null);
        });
    });

    describe('clearAll', () => {
        test('appelle clearAll exactement une fois sur chacun des 15 loaders', () => {
            const loaders = createLoaders();

            loaders.clearAll();

            ALL_LOADER_KEYS.forEach(key => {
                expect(loaders[key].clearAll).toHaveBeenCalledTimes(1);
            });
        });

        test('n\'affecte pas les loaders d\'autres instances', () => {
            const loaders1 = createLoaders();
            const loaders2 = createLoaders();

            loaders1.clearAll();

            // loaders2 ne doit pas avoir été affecté
            ALL_LOADER_KEYS.forEach(key => {
                expect(loaders2[key].clearAll).not.toHaveBeenCalled();
            });
        });
    });

    describe('prime', () => {
        test('amorce le loader metadata avec les données fournies', async () => {
            const loaders = createLoaders();

            await loaders.prime({
                metadata: [{ key: 'age', value: { name: 'age', type: 'integer' } }]
            });

            expect(loaders.metadata.prime).toHaveBeenCalledWith('age', { name: 'age', type: 'integer' });
        });

        test('amorce le loader dimension', async () => {
            const loaders = createLoaders();

            await loaders.prime({
                dimensions: [{ key: 'country', value: [{ value: '1', label: 'France' }] }]
            });

            expect(loaders.dimension.prime).toHaveBeenCalledWith('country', [{ value: '1', label: 'France' }]);
        });

        test('amorce le loader fact', async () => {
            const loaders = createLoaders();

            await loaders.prime({
                facts: [{ key: 'key1', value: { id: 1 } }]
            });

            expect(loaders.fact.prime).toHaveBeenCalledWith('key1', { id: 1 });
        });

        test('amorce le loader selectOptions', async () => {
            const loaders = createLoaders();

            await loaders.prime({
                selectOptions: [{ key: 'country', value: [{ value: '1', label: 'FR' }] }]
            });

            expect(loaders.selectOptions.prime).toHaveBeenCalledWith('country', [{ value: '1', label: 'FR' }]);
        });

        test('gère un appel sans argument gracieusement', async () => {
            const loaders = createLoaders();
            await expect(loaders.prime()).resolves.not.toThrow();
        });

        test('gère un objet vide gracieusement', async () => {
            const loaders = createLoaders();
            await expect(loaders.prime({})).resolves.not.toThrow();
        });

        test('amorce plusieurs loaders indépendamment', async () => {
            const loaders = createLoaders();

            await loaders.prime({
                metadata: [
                    { key: 'field1', value: { type: 'string' } },
                    { key: 'field2', value: { type: 'integer' } }
                ],
                selectOptions: [
                    { key: 'country', value: [{ value: '1', label: 'FR' }] }
                ]
            });

            // Chaque loader a ses propres mocks, les compteurs sont indépendants
            expect(loaders.metadata.prime).toHaveBeenCalledTimes(2);
            expect(loaders.selectOptions.prime).toHaveBeenCalledTimes(1);
            // Les autres loaders ne sont pas touchés
            expect(loaders.fact.prime).not.toHaveBeenCalled();
        });
    });
});

describe('createLoadersForRequest', () => {
    test('crée un nouvel objet loaders à chaque appel', () => {
        const loaders1 = createLoadersForRequest('db1');
        const loaders2 = createLoadersForRequest('db2');

        expect(loaders1).not.toBe(loaders2);
    });

    test('a la même structure pour des bases différentes', () => {
        const loaders1 = createLoadersForRequest('db1');
        const loaders2 = createLoadersForRequest('db2');

        expect(Object.keys(loaders1)).toEqual(Object.keys(loaders2));
    });

    test('transmet le databaseId correctement', () => {
        createLoadersForRequest('test-db');
        expect(createMetadataLoader).toHaveBeenCalledWith('test-db');
    });

    test('fonctionne sans databaseId', () => {
        const loaders = createLoadersForRequest();
        expect(loaders).toBeDefined();
        expect(typeof loaders.clearAll).toBe('function');
    });

    test('chaque appel retourne des instances de loaders distinctes', () => {
        const loaders1 = createLoadersForRequest();
        const loaders2 = createLoadersForRequest();

        // Les loaders sont des objets distincts (makeMockLoader crée de nouvelles instances)
        expect(loaders1.metadata).not.toBe(loaders2.metadata);
    });
});
