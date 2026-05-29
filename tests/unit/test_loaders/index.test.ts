/**
 * Unit tests for createLoaders and createLoadersForRequest (src/loaders/index.ts).
 *
 * Verifies structure of the loaders object, databaseId propagation to each
 * factory, clearAll broadcasting, and prime() seeding of individual loaders.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import { makeLoaderConfig, makeDatabaseManager } from '../../helpers/mocks.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Instance d'un loader mocké — toutes les méthodes DataLoader simulées. */
interface MockLoader {
  load: jest.Mock;
  loadMany: jest.Mock;
  clear: jest.Mock;
  clearAll: jest.Mock;
  prime: jest.Mock;
}

/** Objet loaders retourné par createLoaders — toutes les clés standard. */
interface LoadersObject {
  metadata: MockLoader;
  dimension: MockLoader;
  dimensionValue: MockLoader;
  fact: MockLoader;
  factWithCount: MockLoader;
  factWithMetadata: MockLoader;
  aggregatedFacts: MockLoader;
  aggregatedFactsWithMetadata: MockLoader;
  aggregatedFactsWithCount: MockLoader;
  selectOptions: MockLoader;
  catalogMetadata: MockLoader;
  catalogDimensionNames: MockLoader;
  compareFacts: MockLoader;
  compareAggregatedFacts: MockLoader;
  crossDatabaseSelectOptions: MockLoader;
  clearAll: () => void;
  prime: (data?: PrimeData) => Promise<void>;
  [key: string]: MockLoader | ((...args: unknown[]) => unknown);
}

/** Données d'amorçage passées à prime(). */
interface PrimeData {
  metadata?: Array<{ key: string; value: unknown }>;
  dimensions?: Array<{ key: string; value: unknown }>;
  facts?: Array<{ key: string; value: unknown }>;
  selectOptions?: Array<{ key: string; value: unknown }>;
}

/** Module index.ts après import dynamique. */
interface LoadersIndexModule {
  createLoaders: (databaseId?: string | null) => LoadersObject;
  createLoadersForRequest: (databaseId?: string | null) => LoadersObject;
}

// ─── Fabrique de mock loader ──────────────────────────────────────────────────

/** Création d'un mock loader avec des jest.fn() indépendantes par instance. */
const makeMockLoader = (): MockLoader => ({
  load: jest.fn(),
  loadMany: jest.fn(),
  clear: jest.fn(),
  clearAll: jest.fn(),
  prime: jest.fn(),
});

// ─── État des mocks partagés ───────────────────────────────────────────────────

// Configuration et manager de base de données mockés
const mockConfig = makeLoaderConfig();
const mockDatabaseManager = makeDatabaseManager();

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({ config: mockConfig }));
jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));
jest.unstable_mockModule('../../../src/utils/cache.js', () => ({ withCache: jest.fn() }));
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Chaque factory retourne une instance unique avec ses propres jest.fn()
jest.unstable_mockModule('../../../src/loaders/metadata.js', () => ({
  createMetadataLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/dimension.js', () => ({
  createDimensionLoader: jest.fn(() => makeMockLoader()),
  createDimensionValueLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/fact.js', () => ({
  createFactLoader: jest.fn(() => makeMockLoader()),
  createFactWithCountLoader: jest.fn(() => makeMockLoader()),
  createFactWithMetadataLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/aggregated-facts.js', () => ({
  createAggregatedFactsLoader: jest.fn(() => makeMockLoader()),
  createAggregatedFactsWithMetadataLoader: jest.fn(() => makeMockLoader()),
  createAggregatedFactsWithCountLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/select-options.js', () => ({
  createSelectOptionsLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/catalog.js', () => ({
  createCatalogMetadataLoader: jest.fn(() => makeMockLoader()),
  createCatalogDimensionNamesLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/cross-database.js', () => ({
  createCompareFacts: jest.fn(() => makeMockLoader()),
  createCompareAggregatedFacts: jest.fn(() => makeMockLoader()),
  createCrossDatabaseSelectOptions: jest.fn(() => makeMockLoader()),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Déclarations avant beforeAll — remplies après résolution des mocks
let createLoaders: LoadersIndexModule['createLoaders'];
let createLoadersForRequest: LoadersIndexModule['createLoadersForRequest'];
let createMetadataLoader: jest.Mock;
let createDimensionLoader: jest.Mock;
let createDimensionValueLoader: jest.Mock;
let createFactLoader: jest.Mock;
let createFactWithCountLoader: jest.Mock;
let createFactWithMetadataLoader: jest.Mock;
let createAggregatedFactsLoader: jest.Mock;
let createAggregatedFactsWithMetadataLoader: jest.Mock;
let createAggregatedFactsWithCountLoader: jest.Mock;
let createSelectOptionsLoader: jest.Mock;
let createCatalogMetadataLoader: jest.Mock;
let createCatalogDimensionNamesLoader: jest.Mock;
let createCompareFacts: jest.Mock;
let createCompareAggregatedFacts: jest.Mock;
let createCrossDatabaseSelectOptions: jest.Mock;

beforeAll(async () => {
  ({ createLoaders, createLoadersForRequest } =
    (await import('../../../src/loaders/index.js')) as unknown as LoadersIndexModule);

  ({ createMetadataLoader } = (await import('../../../src/loaders/metadata.js')) as {
    createMetadataLoader: jest.Mock;
  });

  ({ createDimensionLoader, createDimensionValueLoader } =
    (await import('../../../src/loaders/dimension.js')) as {
      createDimensionLoader: jest.Mock;
      createDimensionValueLoader: jest.Mock;
    });

  ({ createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader } =
    (await import('../../../src/loaders/fact.js')) as {
      createFactLoader: jest.Mock;
      createFactWithCountLoader: jest.Mock;
      createFactWithMetadataLoader: jest.Mock;
    });

  ({
    createAggregatedFactsLoader,
    createAggregatedFactsWithMetadataLoader,
    createAggregatedFactsWithCountLoader,
  } = (await import('../../../src/loaders/aggregated-facts.js')) as {
    createAggregatedFactsLoader: jest.Mock;
    createAggregatedFactsWithMetadataLoader: jest.Mock;
    createAggregatedFactsWithCountLoader: jest.Mock;
  });

  ({ createSelectOptionsLoader } = (await import('../../../src/loaders/select-options.js')) as {
    createSelectOptionsLoader: jest.Mock;
  });

  ({ createCatalogMetadataLoader, createCatalogDimensionNamesLoader } =
    (await import('../../../src/loaders/catalog.js')) as {
      createCatalogMetadataLoader: jest.Mock;
      createCatalogDimensionNamesLoader: jest.Mock;
    });

  ({ createCompareFacts, createCompareAggregatedFacts, createCrossDatabaseSelectOptions } =
    (await import('../../../src/loaders/cross-database.js')) as {
      createCompareFacts: jest.Mock;
      createCompareAggregatedFacts: jest.Mock;
      createCrossDatabaseSelectOptions: jest.Mock;
    });
});

// Clés de tous les loaders dans l'objet retourné par createLoaders
const ALL_LOADER_KEYS: Array<keyof Omit<LoadersObject, 'clearAll' | 'prime'>> = [
  'metadata',
  'dimension',
  'dimensionValue',
  'fact',
  'factWithCount',
  'factWithMetadata',
  'aggregatedFacts',
  'aggregatedFactsWithMetadata',
  'aggregatedFactsWithCount',
  'selectOptions',
  'catalogMetadata',
  'catalogDimensionNames',
  'compareFacts',
  'compareAggregatedFacts',
  'crossDatabaseSelectOptions',
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createLoaders', () => {
  // ── Structure de l'objet retourné ─────────────────────────────────────────

  describe("structure de l'objet retourné", () => {
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

  // ── Transmission du databaseId ────────────────────────────────────────────

  describe('transmission du databaseId', () => {
    test('passe le databaseId à tous les loaders spécifiques à une base', () => {
      const databaseId = 'analytics';
      createLoaders(databaseId);

      expect(createMetadataLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createDimensionLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createDimensionValueLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createFactLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createFactWithCountLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createFactWithMetadataLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createAggregatedFactsLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createAggregatedFactsWithMetadataLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createAggregatedFactsWithCountLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createSelectOptionsLoader).toHaveBeenCalledWith(databaseId, null);
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
      expect(createMetadataLoader).toHaveBeenCalledWith(null, null);
    });
  });

  // ── Diffusion de clearAll ─────────────────────────────────────────────────

  describe('clearAll', () => {
    test('appelle clearAll exactement une fois sur chacun des 15 loaders', () => {
      const loaders = createLoaders();

      loaders.clearAll();

      ALL_LOADER_KEYS.forEach((key) => {
        expect((loaders[key] as MockLoader).clearAll).toHaveBeenCalledTimes(1);
      });
    });

    test("n'affecte pas les loaders d'autres instances", () => {
      const loaders1 = createLoaders();
      const loaders2 = createLoaders();

      loaders1.clearAll();

      // Loaders2 ne doit pas avoir été affecté
      ALL_LOADER_KEYS.forEach((key) => {
        expect((loaders2[key] as MockLoader).clearAll).not.toHaveBeenCalled();
      });
    });
  });

  // ── Amorçage des loaders via prime ────────────────────────────────────────

  describe('prime', () => {
    test('amorce le loader metadata avec les données fournies', async () => {
      const loaders = createLoaders();

      await loaders.prime({
        metadata: [{ key: 'age', value: { name: 'age', type: 'integer' } }],
      });

      expect(loaders.metadata.prime).toHaveBeenCalledWith('age', { name: 'age', type: 'integer' });
    });

    test('amorce le loader dimension', async () => {
      const loaders = createLoaders();

      await loaders.prime({
        dimensions: [{ key: 'country', value: [{ value: '1', label: 'France' }] }],
      });

      expect(loaders.dimension.prime).toHaveBeenCalledWith('country', [
        { value: '1', label: 'France' },
      ]);
    });

    test('amorce le loader fact', async () => {
      const loaders = createLoaders();

      await loaders.prime({
        facts: [{ key: 'key1', value: { id: 1 } }],
      });

      expect(loaders.fact.prime).toHaveBeenCalledWith('key1', { id: 1 });
    });

    test('amorce le loader selectOptions', async () => {
      const loaders = createLoaders();

      await loaders.prime({
        selectOptions: [{ key: 'country', value: [{ value: '1', label: 'FR' }] }],
      });

      expect(loaders.selectOptions.prime).toHaveBeenCalledWith('country', [
        { value: '1', label: 'FR' },
      ]);
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
          { key: 'field2', value: { type: 'integer' } },
        ],
        selectOptions: [{ key: 'country', value: [{ value: '1', label: 'FR' }] }],
      });

      // Chaque loader a ses propres mocks — compteurs indépendants
      expect(loaders.metadata.prime).toHaveBeenCalledTimes(2);
      expect(loaders.selectOptions.prime).toHaveBeenCalledTimes(1);
      // Les autres loaders ne sont pas touchés
      expect(loaders.fact.prime).not.toHaveBeenCalled();
    });
  });
});

// ─── createLoadersForRequest ──────────────────────────────────────────────────

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
    expect(createMetadataLoader).toHaveBeenCalledWith('test-db', null);
  });

  test('fonctionne sans databaseId', () => {
    const loaders = createLoadersForRequest();
    expect(loaders).toBeDefined();
    expect(typeof loaders.clearAll).toBe('function');
  });

  test('chaque appel retourne des instances de loaders distinctes', () => {
    const loaders1 = createLoadersForRequest();
    const loaders2 = createLoadersForRequest();

    // Instances distinctes — makeMockLoader crée de nouveaux objets à chaque appel
    expect(loaders1.metadata).not.toBe(loaders2.metadata);
  });
});
