/**
 * Unit tests for CrossDatabaseLoader (src/loaders/cross-database.ts).
 *
 * Verifies fact comparison across two databases (JOIN generation, numeric
 * coercion, null handling), aggregated comparison with CTEs, and cross-database
 * select options for categorical and non-categorical fields.
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

/** Paramètres pour la comparaison de faits bruts entre deux bases. */
interface CompareFactsParams {
  databaseA: string;
  databaseB: string;
  joinFields: string[];
  limit: number;
  offset: number;
  sort: Array<{ field: string; order: string }>;
}

/** Paramètres pour la comparaison de faits agrégés entre deux bases. */
interface CompareAggregatedParams {
  databaseA: string;
  databaseB: string;
  groupBy: string;
  aggregation: string;
  limit: number;
  offset: number;
}

/** Paramètres pour les options de sélection cross-database. */
interface CrossDatabaseSelectParams {
  fieldName: string;
  databases: string[];
  limit: number;
}

/** Ligne de comparaison retournée par la base de données. */
interface CompareRow {
  key: string;
  valueA: number | string | null;
  valueB: number | string | null;
  delta: number | string | null;
  deltaPercent: number | string | null;
}

/** Résultat de comparaison après traitement. */
interface CompareResult {
  key: string;
  valueA: number | null;
  valueB: number | null;
  delta: number | null;
  deltaPercent: number | null;
}

/** Instance d'un loader DataLoader — interface minimale. */
interface DataLoaderInstance {
  load: (params: unknown) => Promise<unknown>;
}

/** Module cross-database.ts après import dynamique. */
interface CrossDatabaseModule {
  createCompareFacts: () => DataLoaderInstance;
  createCompareAggregatedFacts: () => DataLoaderInstance;
  createCrossDatabaseSelectOptions: () => DataLoaderInstance;
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
let createCompareFacts: CrossDatabaseModule['createCompareFacts'];
let createCompareAggregatedFacts: CrossDatabaseModule['createCompareAggregatedFacts'];
let createCrossDatabaseSelectOptions: CrossDatabaseModule['createCrossDatabaseSelectOptions'];

beforeAll(async () => {
  ({ createCompareFacts, createCompareAggregatedFacts, createCrossDatabaseSelectOptions } =
    await import('../../../src/loaders/cross-database.js') as unknown as CrossDatabaseModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CrossDatabaseLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Comparaison de faits bruts ────────────────────────────────────────────

  describe('createCompareFacts', () => {
    test('crée un DataLoader valide', () => {
      const loader = createCompareFacts();
      expect(loader).toBeDefined();
      expect(typeof loader.load).toBe('function');
    });

    test('retourne les données de comparaison entre deux bases', async () => {
      const rows: CompareRow[] = [
        { key: '1', valueA: 100, valueB: 120, delta: 20, deltaPercent: 20 },
      ];
      mockConnection.all
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareFacts();
      const result = await loader.load({
        databaseA: 'db_2023',
        databaseB: 'db_2024',
        joinFields: ['id'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams) as Record<string, unknown>;

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('hasNextPage', false);
      expect(result).toHaveProperty('currentPage', 1);
      expect(result).toHaveProperty('totalPages', 1);
    });

    test('inclut les deux catalogues dans la requête JOIN', async () => {
      mockConnection.all
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareFacts();
      await loader.load({
        databaseA: 'db_a',
        databaseB: 'db_b',
        joinFields: ['country'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams);

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('"db_a"');
      expect(query).toContain('"db_b"');
      expect(query).toContain('JOIN');
    });

    test('gère plusieurs joinFields', async () => {
      mockConnection.all
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareFacts();
      await loader.load({
        databaseA: 'db_a',
        databaseB: 'db_b',
        joinFields: ['country', 'year'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams);

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('CONCAT');
    });

    test('convertit les valeurs numériques correctement', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{
          key: '42',
          valueA: '100.5',
          valueB: '120.0',
          delta: '19.5',
          deltaPercent: '19.4',
        }])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareFacts();
      const result = await loader.load({
        databaseA: 'db_a',
        databaseB: 'db_b',
        joinFields: ['id'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams) as { data: CompareResult[] };

      expect(typeof result.data[0].valueA).toBe('number');
      expect(typeof result.data[0].valueB).toBe('number');
      expect(typeof result.data[0].delta).toBe('number');
    });

    test('gère les valeurs null dans delta et deltaPercent', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{
          key: '1',
          valueA: null,
          valueB: 100,
          delta: null,
          deltaPercent: null,
        }])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareFacts();
      const result = await loader.load({
        databaseA: 'db_a',
        databaseB: 'db_b',
        joinFields: ['id'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams) as { data: CompareResult[] };

      expect(result.data[0].valueA).toBeNull();
      expect(result.data[0].delta).toBeNull();
    });

    test('lève une erreur pour un joinField invalide', async () => {
      const loader = createCompareFacts();
      // validateIdentifier lance une erreur → catchée par createLoader → null
      const result = await loader.load({
        databaseA: 'db_a',
        databaseB: 'db_b',
        joinFields: ['bad field!'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams);

      expect(result).toBeNull();
    });
  });

  // ── Comparaison de faits agrégés ──────────────────────────────────────────

  describe('createCompareAggregatedFacts', () => {
    test('crée un DataLoader valide', () => {
      const loader = createCompareAggregatedFacts();
      expect(loader).toBeDefined();
    });

    test('retourne les faits agrégés comparés', async () => {
      mockConnection.all
        .mockResolvedValueOnce([
          { key: 'FR', valueA: 1000, valueB: 1200, delta: 200, deltaPercent: 20 },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareAggregatedFacts();
      const result = await loader.load({
        databaseA: 'db_2023',
        databaseB: 'db_2024',
        groupBy: 'country',
        aggregation: 'SUM',
        limit: 10,
        offset: 0,
      } satisfies CompareAggregatedParams) as { data: CompareResult[] };

      expect(result).toHaveProperty('data');
      expect(result.data[0]).toHaveProperty('key', 'FR');
      expect(result.data[0]).toHaveProperty('valueA');
      expect(result.data[0]).toHaveProperty('delta');
    });

    test('utilise les CTEs pour éviter le produit cartésien', async () => {
      mockConnection.all
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareAggregatedFacts();
      await loader.load({
        databaseA: 'db_a',
        databaseB: 'db_b',
        groupBy: 'country',
        aggregation: 'SUM',
        limit: 10,
        offset: 0,
      } satisfies CompareAggregatedParams);

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('WITH');
      expect(query).toContain('agg_a');
      expect(query).toContain('agg_b');
    });

    test('lève une erreur pour un groupBy invalide', async () => {
      const loader = createCompareAggregatedFacts();
      const result = await loader.load({
        databaseA: 'db_a',
        databaseB: 'db_b',
        groupBy: 'bad field!',
        aggregation: 'SUM',
        limit: 10,
        offset: 0,
      } satisfies CompareAggregatedParams);

      expect(result).toBeNull();
    });
  });

  // ── Options de sélection cross-database ───────────────────────────────────

  describe('createCrossDatabaseSelectOptions', () => {
    test('crée un DataLoader valide', () => {
      const loader = createCrossDatabaseSelectOptions();
      expect(loader).toBeDefined();
    });

    test("retourne un tableau vide si aucune base fournie", async () => {
      mockConnection.all.mockResolvedValue([{ is_categorical: true }]);

      const loader = createCrossDatabaseSelectOptions();
      const result = await loader.load({
        fieldName: 'country',
        databases: [],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      expect(result).toEqual([]);
    });

    test('charge depuis la dimension pour un champ catégoriel', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: true }])      // métadonnée
        .mockResolvedValueOnce([{ value: '1', label: 'France' }]); // dimension

      const loader = createCrossDatabaseSelectOptions();
      const result = await loader.load({
        fieldName: 'country',
        databases: ['db1', 'db2'],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      expect(Array.isArray(result)).toBe(true);
      const dimQuery = mockConnection.all.mock.calls[1][0] as string;
      expect(dimQuery).toContain('dim_country');
    });

    test('charge depuis fact_table pour un champ non catégoriel', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: false }])     // métadonnée
        .mockResolvedValueOnce([{ value: '100' }]);             // table des faits

      const loader = createCrossDatabaseSelectOptions();
      await loader.load({
        fieldName: 'amount',
        databases: ['db1', 'db2'],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      const factQuery = mockConnection.all.mock.calls[1][0] as string;
      expect(factQuery).toContain('fact_table');
      expect(factQuery).toContain('DISTINCT');
    });

    test('lève une erreur pour un fieldName invalide', async () => {
      const loader = createCrossDatabaseSelectOptions();
      const result = await loader.load({
        fieldName: 'bad field!',
        databases: ['db1'],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      expect(result).toBeNull();
    });
  });
});
