/**
 * Unit tests for AggregatedFactsLoader (src/loaders/aggregated-facts.ts).
 *
 * Verifies aggregation map completeness, result formatting (type coercion,
 * _groupByField injection), pagination metadata, and statistical calculations
 * (mean, median, stdDev, quartiles).
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import {
  makeLoaderConfig,
  makePool,
  makeConnection,
  makeDatabaseManager,
} from '../../helpers/mocks.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Paramètres de base pour le chargement de faits agrégés. */
interface AggregatedFactsParams {
  fields: string[] | null;
  filters: string | null;
  structuredFilters: unknown | null;
  groupBy: string;
  aggregation: string;
  limit: number;
  offset: number;
  sort: Array<{ field: string; order: string }>;
}

/** Résultat agrégé enrichi d'un _groupByField. */
interface AggregatedResult {
  key: string;
  aggregatedValue: number;
  count: number;
  _groupByField: string;
}

/** Statistiques descriptives calculées sur un jeu de valeurs. */
interface Statistics {
  mean: number | null;
  median: number | null;
  stdDev: number | null;
  quartiles: number[] | null;
}

/** Carte des fonctions d'agrégation disponibles. */
interface AggregationMap {
  SUM: string;
  AVG: string;
  MAX: string;
  MIN: string;
  COUNT: string;
  MEDIAN?: string;
  MODE?: string;
  [key: string]: string | undefined;
}

/** Instance d'un loader DataLoader — interface minimale. */
interface DataLoaderInstance {
  load: (params: unknown) => Promise<unknown>;
}

/** Instance de AggregatedFactsLoader exposant calculateStatistics. */
interface AggregatedFactsLoaderInstance {
  calculateStatistics: (values: number[]) => Statistics;
}

/** Constructeur de AggregatedFactsLoader. */
interface AggregatedFactsLoaderConstructor {
  new (databaseId?: string | null): AggregatedFactsLoaderInstance;
  AGGREGATION_MAP: AggregationMap;
}

/** Module aggregated-facts.ts après import dynamique. */
interface AggregatedFactsModule {
  createAggregatedFactsLoader: (databaseId?: string | null) => DataLoaderInstance;
  createAggregatedFactsWithMetadataLoader: (databaseId?: string | null) => DataLoaderInstance;
  createAggregatedFactsWithCountLoader: (databaseId?: string | null) => DataLoaderInstance;
  AggregatedFactsLoader: AggregatedFactsLoaderConstructor;
}

// ─── État des mocks partagés ───────────────────────────────────────────────────

// Connexion et pool réutilisés dans tous les tests du fichier
const mockPool = makePool();
const mockConnection = makeConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));

jest.unstable_mockModule('../../../src/utils/cache.js', () => ({
  withCache: jest.fn().mockImplementation(async (_k: unknown, fn: () => Promise<unknown>) => fn()),
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Déclarations avant beforeAll — remplies après résolution des mocks
let createAggregatedFactsLoader: AggregatedFactsModule['createAggregatedFactsLoader'];
let createAggregatedFactsWithMetadataLoader: AggregatedFactsModule['createAggregatedFactsWithMetadataLoader'];
let createAggregatedFactsWithCountLoader: AggregatedFactsModule['createAggregatedFactsWithCountLoader'];
let AggregatedFactsLoader: AggregatedFactsLoaderConstructor;

beforeAll(async () => {
  ({
    createAggregatedFactsLoader,
    createAggregatedFactsWithMetadataLoader,
    createAggregatedFactsWithCountLoader,
    AggregatedFactsLoader,
  } =
    (await import('../../../src/loaders/aggregated-facts.js')) as unknown as AggregatedFactsModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AggregatedFactsLoader', () => {
  // Paramètres de base réutilisés dans chaque test
  const baseParams: AggregatedFactsParams = {
    fields: null,
    filters: null,
    structuredFilters: null,
    groupBy: 'country',
    aggregation: 'SUM',
    limit: 10,
    offset: 0,
    sort: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Carte des agrégations disponibles ────────────────────────────────────

  describe('AGGREGATION_MAP', () => {
    test("contient toutes les fonctions d'agrégation", () => {
      expect(AggregatedFactsLoader.AGGREGATION_MAP).toMatchObject({
        SUM: 'SUM',
        AVG: 'AVG',
        MAX: 'MAX',
        MIN: 'MIN',
        COUNT: 'COUNT',
      });
    });

    test('inclut MEDIAN et MODE', () => {
      expect(AggregatedFactsLoader.AGGREGATION_MAP.MEDIAN).toBeDefined();
      expect(AggregatedFactsLoader.AGGREGATION_MAP.MODE).toBeDefined();
    });
  });

  // ── Instanciation ─────────────────────────────────────────────────────────

  describe('createAggregatedFactsLoader', () => {
    test('crée un DataLoader valide', () => {
      const loader = createAggregatedFactsLoader('main');
      expect(loader).toBeDefined();
      expect(typeof loader.load).toBe('function');
    });
  });

  // ── Chargement au format par défaut ──────────────────────────────────────

  describe('loadAggregatedFacts - format default', () => {
    test('retourne un tableau de résultats agrégés', async () => {
      mockConnection.all.mockResolvedValue([
        { key: 'FR', aggregatedValue: 500, count: 10 },
        { key: 'DE', aggregatedValue: 300, count: 5 },
      ]);

      const loader = createAggregatedFactsLoader('main');
      const result = (await loader.load({ ...baseParams })) as AggregatedResult[];

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        key: 'FR',
        aggregatedValue: 500,
        count: 10,
        _groupByField: 'country',
      });
    });

    test('convertit les valeurs en nombres', async () => {
      mockConnection.all.mockResolvedValue([{ key: '1', aggregatedValue: '42.5', count: '3' }]);

      const loader = createAggregatedFactsLoader('main');
      const result = (await loader.load({ ...baseParams })) as AggregatedResult[];

      expect(typeof result[0].aggregatedValue).toBe('number');
      expect(typeof result[0].count).toBe('number');
      expect(result[0].aggregatedValue).toBe(42.5);
    });

    test('convertit les clés en chaînes', async () => {
      mockConnection.all.mockResolvedValue([{ key: 42, aggregatedValue: 100, count: 1 }]);

      const loader = createAggregatedFactsLoader('main');
      const result = (await loader.load({ ...baseParams })) as AggregatedResult[];

      expect(result[0].key).toBe('42');
    });

    test("inclut la fonction d'agrégation correcte dans la requête", async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createAggregatedFactsLoader('main');
      await loader.load({ ...baseParams, aggregation: 'AVG' });

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('AVG(value)');
    });

    test('utilise SUM par défaut pour une agrégation inconnue', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createAggregatedFactsLoader('main');
      await loader.load({ ...baseParams, aggregation: 'UNKNOWN' });

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('SUM(value)');
    });

    test('inclut LIMIT et OFFSET', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createAggregatedFactsLoader('main');
      await loader.load({ ...baseParams, limit: 5, offset: 10 });

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('LIMIT 5');
      expect(query).toContain('OFFSET 10');
    });
  });

  // ── Chargement avec comptage des groupes ──────────────────────────────────

  describe('createAggregatedFactsWithCountLoader', () => {
    test('retourne les données avec le comptage des groupes', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ key: 'FR', aggregatedValue: 500, count: 10 }])
        .mockResolvedValueOnce([{ totalGroups: 25 }]);

      const loader = createAggregatedFactsWithCountLoader('main');
      const result = (await loader.load({ ...baseParams })) as Record<string, unknown>;

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('totalGroups', 25);
      expect(result).toHaveProperty('hasNextPage', true);
      expect(result).toHaveProperty('currentPage', 1);
      expect(result).toHaveProperty('totalPages', 3);
    });
  });

  // ── Chargement avec métadonnées ───────────────────────────────────────────

  describe('createAggregatedFactsWithMetadataLoader', () => {
    test('retourne les données avec les métadonnées', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ key: 'FR', aggregatedValue: 500, count: 10 }])
        .mockResolvedValueOnce([{ name: 'country', type: 'string', is_categorical: 1 }]);

      const loader = createAggregatedFactsWithMetadataLoader('main');
      const result = (await loader.load({ ...baseParams })) as Record<string, unknown>;

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('metadata');
      const metadata = result['metadata'] as Record<string, unknown>;
      expect(metadata).toHaveProperty('count', 1);
      expect(metadata).toHaveProperty('valueExtent');
      expect(metadata).toHaveProperty('statistics');
    });

    test('retourne des métadonnées vides pour un résultat vide', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const loader = createAggregatedFactsWithMetadataLoader('main');
      const result = (await loader.load({ ...baseParams })) as Record<string, unknown>;
      const metadata = result['metadata'] as Record<string, unknown>;

      expect(metadata.count).toBe(0);
      expect(metadata.keyExtent).toBeNull();
    });
  });

  // ── Calcul des statistiques descriptives ──────────────────────────────────

  describe('calculateStatistics', () => {
    let loaderInstance: AggregatedFactsLoaderInstance;

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

    test("calcule l'écart-type", () => {
      const stats = loaderInstance.calculateStatistics([2, 4, 6]);
      expect(stats.stdDev).toBeCloseTo(1.633, 2);
    });

    test('retourne les quartiles', () => {
      const stats = loaderInstance.calculateStatistics([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(stats.quartiles).toHaveLength(5);
      expect(stats.quartiles![0]).toBe(1); // minimum
      expect(stats.quartiles![4]).toBe(8); // maximum
    });

    test('gère une valeur unique', () => {
      const stats = loaderInstance.calculateStatistics([42]);
      expect(stats.mean).toBe(42);
      expect(stats.median).toBe(42);
      expect(stats.stdDev).toBe(0);
    });
  });
});
