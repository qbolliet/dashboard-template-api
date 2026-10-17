/**
 * Unit tests for createLoaders (src/loaders/index.ts).
 *
 * Verifies structure of the loaders object, databaseId propagation to each
 * factory.
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
  fact: MockLoader;
  factWithCount: MockLoader;
  factWithMetadata: MockLoader;
  aggregates: MockLoader;
  aggregateGroupCount: MockLoader;
  selectOptions: MockLoader;
  selectOptionsTree: MockLoader;
  catalogMetadata: MockLoader;
  compareFacts: MockLoader;
  compareAggregatedFacts: MockLoader;
  crossDatabaseSelectOptions: MockLoader;
  [key: string]: MockLoader | ((...args: unknown[]) => unknown);
}

/** Module index.ts après import dynamique. */
interface LoadersIndexModule {
  createLoaders: (databaseId?: string | null) => LoadersObject;
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
  // La garde de version (db/schema-version.js) crée son propre logger contextuel
  createContextLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    database: jest.fn(),
  }),
}));

// Chaque factory retourne une instance unique avec ses propres jest.fn()
jest.unstable_mockModule('../../../src/loaders/metadata.js', () => ({
  createMetadataLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/fact.js', () => ({
  createFactLoader: jest.fn(() => makeMockLoader()),
  createFactWithCountLoader: jest.fn(() => makeMockLoader()),
  createFactWithMetadataLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/aggregates.js', () => ({
  createAggregatesLoader: jest.fn(() => makeMockLoader()),
  createAggregateGroupCountLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/select-options.js', () => ({
  createSelectOptionsLoader: jest.fn(() => makeMockLoader()),
  createSelectOptionsTreeLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/catalog.js', () => ({
  createCatalogMetadataLoader: jest.fn(() => makeMockLoader()),
}));

jest.unstable_mockModule('../../../src/loaders/cross-database.js', () => ({
  createCompareFacts: jest.fn(() => makeMockLoader()),
  createCompareAggregatedFacts: jest.fn(() => makeMockLoader()),
  createCrossDatabaseSelectOptions: jest.fn(() => makeMockLoader()),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Déclarations avant beforeAll — remplies après résolution des mocks
let createLoaders: LoadersIndexModule['createLoaders'];
let createMetadataLoader: jest.Mock;
let createFactLoader: jest.Mock;
let createFactWithCountLoader: jest.Mock;
let createFactWithMetadataLoader: jest.Mock;
let createAggregatesLoader: jest.Mock;
let createAggregateGroupCountLoader: jest.Mock;
let createSelectOptionsLoader: jest.Mock;
let createSelectOptionsTreeLoader: jest.Mock;
let createCatalogMetadataLoader: jest.Mock;
let createCompareFacts: jest.Mock;
let createCompareAggregatedFacts: jest.Mock;
let createCrossDatabaseSelectOptions: jest.Mock;

beforeAll(async () => {
  ({ createLoaders } =
    (await import('../../../src/loaders/index.js')) as unknown as LoadersIndexModule);

  ({ createMetadataLoader } = (await import('../../../src/loaders/metadata.js')) as {
    createMetadataLoader: jest.Mock;
  });

  ({ createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader } =
    (await import('../../../src/loaders/fact.js')) as {
      createFactLoader: jest.Mock;
      createFactWithCountLoader: jest.Mock;
      createFactWithMetadataLoader: jest.Mock;
    });

  ({ createAggregatesLoader, createAggregateGroupCountLoader } =
    (await import('../../../src/loaders/aggregates.js')) as {
      createAggregatesLoader: jest.Mock;
      createAggregateGroupCountLoader: jest.Mock;
    });

  ({ createSelectOptionsLoader, createSelectOptionsTreeLoader } =
    (await import('../../../src/loaders/select-options.js')) as {
      createSelectOptionsLoader: jest.Mock;
      createSelectOptionsTreeLoader: jest.Mock;
    });

  ({ createCatalogMetadataLoader } = (await import('../../../src/loaders/catalog.js')) as {
    createCatalogMetadataLoader: jest.Mock;
  });

  ({ createCompareFacts, createCompareAggregatedFacts, createCrossDatabaseSelectOptions } =
    (await import('../../../src/loaders/cross-database.js')) as {
      createCompareFacts: jest.Mock;
      createCompareAggregatedFacts: jest.Mock;
      createCrossDatabaseSelectOptions: jest.Mock;
    });
});

// Clés de tous les loaders dans l'objet retourné par createLoaders
const ALL_LOADER_KEYS: Array<keyof LoadersObject> = [
  'metadata',
  'fact',
  'factWithCount',
  'factWithMetadata',
  'aggregates',
  'aggregateGroupCount',
  'selectOptions',
  'selectOptionsTree',
  'catalogMetadata',
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
      expect(loaders).toHaveProperty('fact');
      expect(loaders).toHaveProperty('factWithCount');
      expect(loaders).toHaveProperty('factWithMetadata');
      expect(loaders).toHaveProperty('aggregates');
      expect(loaders).toHaveProperty('aggregateGroupCount');
      expect(loaders).toHaveProperty('selectOptions');
    });

    test('contient les loaders catalog', () => {
      const loaders = createLoaders();
      expect(loaders).toHaveProperty('catalogMetadata');
    });

    test('contient les loaders cross-database', () => {
      const loaders = createLoaders();
      expect(loaders).toHaveProperty('compareFacts');
      expect(loaders).toHaveProperty('compareAggregatedFacts');
      expect(loaders).toHaveProperty('crossDatabaseSelectOptions');
    });
  });

  // ── Transmission du databaseId ────────────────────────────────────────────

  describe('transmission du databaseId', () => {
    test('passe le databaseId à tous les loaders spécifiques à une base', () => {
      const databaseId = 'analytics';
      createLoaders(databaseId);

      expect(createMetadataLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createFactLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createFactWithCountLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createFactWithMetadataLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createAggregatesLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createAggregateGroupCountLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createSelectOptionsLoader).toHaveBeenCalledWith(databaseId, null);
      expect(createSelectOptionsTreeLoader).toHaveBeenCalledWith(databaseId, null);
    });

    test('les loaders catalog et cross-database sont créés sans argument', () => {
      createLoaders('analytics');
      expect(createCatalogMetadataLoader).toHaveBeenCalledWith();
      expect(createCompareFacts).toHaveBeenCalledWith();
      expect(createCompareAggregatedFacts).toHaveBeenCalledWith();
      expect(createCrossDatabaseSelectOptions).toHaveBeenCalledWith();
    });

    test('utilise null par défaut si aucun databaseId fourni', () => {
      createLoaders();
      expect(createMetadataLoader).toHaveBeenCalledWith(null, null);
    });
  });
});
