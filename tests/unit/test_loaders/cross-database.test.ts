/**
 * Unit tests for CrossDatabaseLoader (src/loaders/cross-database.ts).
 *
 * Verifies fact comparison across two datasets (label-resolving JOIN generation,
 * numeric coercion, null handling), aggregated comparison with CTEs, and
 * cross-catalog select options for categorical and non-categorical fields.
 *
 * Note: compareFacts/compareAggregatedFacts first query the metadata table of
 * each side (getCategoricalMap) to decide whether each join/groupBy field is
 * categorical. In these unit tests we return empty metadata so fields are treated
 * as continuous (matched on raw values), which keeps the generated SQL simple and
 * deterministic. The two leading mocked `connection.all` results are those
 * metadata lookups; the main query and count query follow.
 *
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

/** Paramètres pour la comparaison de faits bruts entre deux datasets. */
interface CompareFactsParams {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  joinFields: string[];
  limit: number;
  offset: number;
  sort: Array<{ field: string; order: string }>;
}

/** Paramètres pour la comparaison de faits agrégés entre deux datasets. */
interface CompareAggregatedParams {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  groupBy: string;
  aggregation: string;
  limit: number;
  offset: number;
}

/** Paramètres pour les options de sélection cross-catalog. */
interface CrossDatabaseSelectParams {
  fieldName: string;
  catalogs: string[];
  schemas?: (string | null)[];
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
    (await import('../../../src/loaders/cross-database.js')) as unknown as CrossDatabaseModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CrossDatabaseLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Comparaison de faits bruts ────────────────────────────────────────────

  describe('createCompareFacts', () => {
    test('crée un DataLoader valide', () => {
      const loader = createCompareFacts();
      expect(loader).toBeDefined();
      expect(typeof loader.load).toBe('function');
    });

    test('retourne les données de comparaison entre deux datasets', async () => {
      const rows: CompareRow[] = [
        { key: '1', valueA: 100, valueB: 120, delta: 20, deltaPercent: 20 },
      ];
      mockConnection.all
        .mockResolvedValueOnce([]) // getCategoricalMap A
        .mockResolvedValueOnce([]) // getCategoricalMap B
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareFacts();
      const result = (await loader.load({
        catalogA: 'db_2023',
        catalogB: 'db_2024',
        joinFields: ['id'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams)) as Record<string, unknown>;

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('hasNextPage', false);
      expect(result).toHaveProperty('currentPage', 1);
      expect(result).toHaveProperty('totalPages', 1);
    });

    test('inclut les deux catalogues dans la requête JOIN', async () => {
      mockConnection.all
        .mockResolvedValueOnce([]) // getCategoricalMap A
        .mockResolvedValueOnce([]) // getCategoricalMap B
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareFacts();
      await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
        joinFields: ['country'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams);

      // calls[0]/[1] = métadonnées ; calls[2] = requête principale
      const query = mockConnection.all.mock.calls[2][0] as string;
      expect(query).toContain('"db_a"');
      expect(query).toContain('"db_b"');
      expect(query).toContain('JOIN');
    });

    test('gère plusieurs joinFields (clé concaténée)', async () => {
      mockConnection.all
        .mockResolvedValueOnce([]) // getCategoricalMap A
        .mockResolvedValueOnce([]) // getCategoricalMap B
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareFacts();
      await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
        joinFields: ['country', 'year'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams);

      const query = mockConnection.all.mock.calls[2][0] as string;
      expect(query).toContain('CONCAT');
    });

    test('convertit les valeurs numériques correctement', async () => {
      mockConnection.all
        .mockResolvedValueOnce([]) // getCategoricalMap A
        .mockResolvedValueOnce([]) // getCategoricalMap B
        .mockResolvedValueOnce([
          {
            key: '42',
            valueA: '100.5',
            valueB: '120.0',
            delta: '19.5',
            deltaPercent: '19.4',
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareFacts();
      const result = (await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
        joinFields: ['id'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams)) as { data: CompareResult[] };

      expect(typeof result.data[0].valueA).toBe('number');
      expect(typeof result.data[0].valueB).toBe('number');
      expect(typeof result.data[0].delta).toBe('number');
    });

    test('gère les valeurs null dans delta et deltaPercent', async () => {
      mockConnection.all
        .mockResolvedValueOnce([]) // getCategoricalMap A
        .mockResolvedValueOnce([]) // getCategoricalMap B
        .mockResolvedValueOnce([
          {
            key: '1',
            valueA: null,
            valueB: 100,
            delta: null,
            deltaPercent: null,
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareFacts();
      const result = (await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
        joinFields: ['id'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams)) as { data: CompareResult[] };

      expect(result.data[0].valueA).toBeNull();
      expect(result.data[0].delta).toBeNull();
    });

    test('lève une erreur pour un joinField invalide', async () => {
      const loader = createCompareFacts();
      // validateIdentifier lance une erreur → catchée par createLoader → null
      const result = await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
        joinFields: ['bad field!'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams);

      expect(result).toBeNull();
    });

    test('résout les champs catégoriels via dim_* avant la jointure', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ name: 'country', is_categorical: 1 }]) // getCategoricalMap A
        .mockResolvedValueOnce([{ name: 'country', is_categorical: 1 }]) // getCategoricalMap B
        .mockResolvedValueOnce([
          { key: 'France', valueA: 100, valueB: 120, delta: 20, deltaPercent: 20 },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareFacts();
      await loader.load({
        catalogA: 'db_2023',
        catalogB: 'db_2024',
        joinFields: ['country'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams);

      // calls[0]/[1] = métadonnées ; calls[2] = requête principale
      const mainQuery = mockConnection.all.mock.calls[2][0] as string;
      // Les deux CTEs joignent leurs tables dim_country respectives
      expect(mainQuery).toContain('JOIN "db_2023".main.dim_country');
      expect(mainQuery).toContain('JOIN "db_2024".main.dim_country');
      // La jointure finale porte sur les labels (jamais les IDs bruts)
      expect(mainQuery).toContain('a.k_country = b.k_country');
    });

    test('supporte les requêtes cross-schéma dans un même catalogue', async () => {
      mockConnection.all
        .mockResolvedValueOnce([]) // getCategoricalMap A
        .mockResolvedValueOnce([]) // getCategoricalMap B
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareFacts();
      await loader.load({
        catalogA: 'db_2023',
        catalogB: 'db_2023',
        schemaA: 'schema_a',
        schemaB: 'schema_b',
        joinFields: ['country'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams);

      const mainQuery = mockConnection.all.mock.calls[2][0] as string;
      expect(mainQuery).toContain('"db_2023".schema_a.fact_table');
      expect(mainQuery).toContain('"db_2023".schema_b.fact_table');
    });

    test('gère le cas asymétrique : catégoriel côté A, brut côté B', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ name: 'country', is_categorical: 1 }]) // catMapA — catégoriel
        .mockResolvedValueOnce([]) // catMapB — non catégoriel
        .mockResolvedValueOnce([
          { key: 'France', valueA: 100, valueB: 120, delta: 20, deltaPercent: 20 },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareFacts();
      const result = (await loader.load({
        catalogA: 'db_2023',
        catalogB: 'db_2024',
        joinFields: ['country'],
        limit: 10,
        offset: 0,
        sort: [],
      } satisfies CompareFactsParams)) as { data: CompareResult[] } | null;

      // La requête réussit malgré l'asymétrie catégorielle
      expect(result).not.toBeNull();
      expect(result!.data[0]).toHaveProperty('key', 'France');

      const mainQuery = mockConnection.all.mock.calls[2][0] as string;
      // Côté A : dim join (champ catégoriel)
      expect(mainQuery).toContain('JOIN "db_2023".main.dim_country');
      // Côté B : valeur brute, pas de dim join
      expect(mainQuery).not.toContain('JOIN "db_2024".main.dim_country');
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
        .mockResolvedValueOnce([]) // getCategoricalMap A
        .mockResolvedValueOnce([]) // getCategoricalMap B
        .mockResolvedValueOnce([
          { key: 'FR', valueA: 1000, valueB: 1200, delta: 200, deltaPercent: 20 },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareAggregatedFacts();
      const result = (await loader.load({
        catalogA: 'db_2023',
        catalogB: 'db_2024',
        groupBy: 'country',
        aggregation: 'SUM',
        limit: 10,
        offset: 0,
      } satisfies CompareAggregatedParams)) as { data: CompareResult[] };

      expect(result).toHaveProperty('data');
      expect(result.data[0]).toHaveProperty('key', 'FR');
      expect(result.data[0]).toHaveProperty('valueA');
      expect(result.data[0]).toHaveProperty('delta');
    });

    test('utilise les CTEs pour éviter le produit cartésien', async () => {
      mockConnection.all
        .mockResolvedValueOnce([]) // getCategoricalMap A
        .mockResolvedValueOnce([]) // getCategoricalMap B
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareAggregatedFacts();
      await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
        groupBy: 'country',
        aggregation: 'SUM',
        limit: 10,
        offset: 0,
      } satisfies CompareAggregatedParams);

      const query = mockConnection.all.mock.calls[2][0] as string;
      expect(query).toContain('WITH');
      expect(query).toContain('agg_a');
      expect(query).toContain('agg_b');
    });

    test('lève une erreur pour un groupBy invalide', async () => {
      const loader = createCompareAggregatedFacts();
      const result = await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
        groupBy: 'bad field!',
        aggregation: 'SUM',
        limit: 10,
        offset: 0,
      } satisfies CompareAggregatedParams);

      expect(result).toBeNull();
    });

    test("résout un groupBy catégoriel via dim_* avant l'agrégation", async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ name: 'country', is_categorical: 1 }]) // catMapA
        .mockResolvedValueOnce([{ name: 'country', is_categorical: 1 }]) // catMapB
        .mockResolvedValueOnce([
          { key: 'France', valueA: 1000, valueB: 1200, delta: 200, deltaPercent: 20 },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const loader = createCompareAggregatedFacts();
      await loader.load({
        catalogA: 'db_2023',
        catalogB: 'db_2024',
        groupBy: 'country',
        aggregation: 'SUM',
        limit: 10,
        offset: 0,
      } satisfies CompareAggregatedParams);

      // calls[0]/[1] = métadonnées ; calls[2] = requête d'agrégation principale
      const query = mockConnection.all.mock.calls[2][0] as string;
      // Chaque CTE agrège par label (d.label), jamais par ID brut
      expect(query).toContain('dim_country');
      expect(query).toContain('GROUP BY d.label');
    });

    test('supporte les requêtes cross-schéma dans un même catalogue', async () => {
      mockConnection.all
        .mockResolvedValueOnce([]) // catMapA
        .mockResolvedValueOnce([]) // catMapB
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareAggregatedFacts();
      await loader.load({
        catalogA: 'db_2023',
        catalogB: 'db_2023',
        schemaA: 'schema_a',
        schemaB: 'schema_b',
        groupBy: 'country',
        aggregation: 'SUM',
        limit: 10,
        offset: 0,
      } satisfies CompareAggregatedParams);

      const query = mockConnection.all.mock.calls[2][0] as string;
      expect(query).toContain('"db_2023".schema_a.fact_table');
      expect(query).toContain('"db_2023".schema_b.fact_table');
    });
  });

  // ── Options de sélection cross-catalog ────────────────────────────────────

  describe('createCrossDatabaseSelectOptions', () => {
    test('crée un DataLoader valide', () => {
      const loader = createCrossDatabaseSelectOptions();
      expect(loader).toBeDefined();
    });

    test('retourne un tableau vide si aucun catalogue fourni', async () => {
      mockConnection.all.mockResolvedValue([{ is_categorical: true }]);

      const loader = createCrossDatabaseSelectOptions();
      const result = await loader.load({
        fieldName: 'country',
        catalogs: [],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      expect(result).toEqual([]);
    });

    test('charge depuis la dimension pour un champ catégoriel (intersection sur label)', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: true }]) // métadonnée
        .mockResolvedValueOnce([{ value: '1', label: 'France' }]); // dimension

      const loader = createCrossDatabaseSelectOptions();
      const result = await loader.load({
        fieldName: 'country',
        catalogs: ['db1', 'db2'],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      expect(Array.isArray(result)).toBe(true);
      const dimQuery = mockConnection.all.mock.calls[1][0] as string;
      expect(dimQuery).toContain('dim_country');
      // L'intersection se fait sur le label, jamais sur l'ID brut
      expect(dimQuery).toContain('label IN');
    });

    test('charge depuis fact_table pour un champ non catégoriel', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: false }]) // métadonnée
        .mockResolvedValueOnce([{ value: '100' }]); // table des faits

      const loader = createCrossDatabaseSelectOptions();
      await loader.load({
        fieldName: 'amount',
        catalogs: ['db1', 'db2'],
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
        catalogs: ['db1'],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      expect(result).toBeNull();
    });
  });
});
