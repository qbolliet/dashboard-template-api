/**
 * Unit tests for CrossDatabaseLoader (src/loaders/cross-database.ts).
 *
 * Verifies fact comparison across two datasets (JOIN generation, numeric
 * coercion, null handling), aggregated comparison with CTEs, and cross-catalog
 * select options.
 *
 * Note: the fact table carries the labels, so no table is consulted before the
 * comparison itself — each loader issues exactly its main query and its count
 * query, which the mocked `connection.all` results follow in that order.
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
  // La garde de version (db/schema-version.js) crée son propre logger contextuel
  createContextLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    database: jest.fn(),
  }),
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
      mockConnection.all.mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total: 1 }]);

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
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareFacts();
      await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
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

    test('gère plusieurs joinFields (clé concaténée)', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareFacts();
      await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
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
      // validateIdentifier lève une GraphQLError BAD_USER_INPUT, propagée par createLoader
      await expect(
        loader.load({
          catalogA: 'db_a',
          catalogB: 'db_b',
          joinFields: ['bad field!'],
          limit: 10,
          offset: 0,
          sort: [],
        } satisfies CompareFactsParams),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    });

    test('joint directement sur les libellés, sans table dim_*', async () => {
      mockConnection.all
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

      const mainQuery = mockConnection.all.mock.calls[0][0] as string;
      // La colonne porte le libellé : aucune table de dimension n'est jointe
      expect(mainQuery).not.toContain('dim_');
      // Chaque côté expose sa colonne de jointure, alignée en VARCHAR
      expect(mainQuery).toContain('CAST(f.country AS VARCHAR) AS k_country');
      expect(mainQuery).toContain('a.k_country = b.k_country');
    });

    test('supporte les requêtes cross-schéma dans un même catalogue', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

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

      const mainQuery = mockConnection.all.mock.calls[0][0] as string;
      expect(mainQuery).toContain('"db_2023".schema_a.fact_table');
      expect(mainQuery).toContain('"db_2023".schema_b.fact_table');
    });

    test('ne lit aucune métadonnée avant de comparer', async () => {
      mockConnection.all
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

      expect(result).not.toBeNull();
      expect(result!.data[0]).toHaveProperty('key', 'France');

      // Deux requêtes seulement : la comparaison et son comptage
      expect(mockConnection.all).toHaveBeenCalledTimes(2);
      const queries = mockConnection.all.mock.calls.map((call) => call[0] as string);
      expect(queries.some((query) => query.includes('.metadata'))).toBe(false);
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
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      const loader = createCompareAggregatedFacts();
      await loader.load({
        catalogA: 'db_a',
        catalogB: 'db_b',
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
      await expect(
        loader.load({
          catalogA: 'db_a',
          catalogB: 'db_b',
          groupBy: 'bad field!',
          aggregation: 'SUM',
          limit: 10,
          offset: 0,
        } satisfies CompareAggregatedParams),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    });

    test('agrège directement sur la colonne, sans jointure de dimension', async () => {
      mockConnection.all
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

      const query = mockConnection.all.mock.calls[0][0] as string;
      // La colonne porte le libellé : GROUP BY direct, aucune table dim_*
      expect(query).not.toContain('dim_');
      expect(query).toContain('GROUP BY country');
      // Les clés des deux côtés sont alignées en VARCHAR avant la jointure
      expect(query).toContain('CAST(country AS VARCHAR) AS key');
    });

    test('supporte les requêtes cross-schéma dans un même catalogue', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

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

      const query = mockConnection.all.mock.calls[0][0] as string;
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
      mockConnection.all.mockResolvedValue([]);

      const loader = createCrossDatabaseSelectOptions();
      const result = await loader.load({
        fieldName: 'country',
        catalogs: [],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      expect(result).toEqual([]);
    });

    test('intersecte les valeurs distinctes des fact tables', async () => {
      mockConnection.all.mockResolvedValueOnce([{ value: 'France', label: 'France' }]);

      const loader = createCrossDatabaseSelectOptions();
      const result = await loader.load({
        fieldName: 'country',
        catalogs: ['db1', 'db2', 'db3'],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      expect(result).toEqual([{ value: 'France', label: 'France' }]);

      // Une seule requête : plus de lecture préalable de metadata
      expect(mockConnection.all).toHaveBeenCalledTimes(1);
      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('fact_table');
      expect(query).toContain('DISTINCT');
      expect(query).toContain('INTERSECT');
      expect(query).not.toContain('dim_');
      // Valeurs alignées en VARCHAR, NULL exclus
      expect(query).toContain('CAST(country AS VARCHAR)');
      expect(query).toContain('IS NOT NULL');
    });

    test('sans autre catalogue, liste les valeurs de la seule cible', async () => {
      mockConnection.all.mockResolvedValueOnce([{ value: '100', label: '100' }]);

      const loader = createCrossDatabaseSelectOptions();
      await loader.load({
        fieldName: 'amount',
        catalogs: ['db1'],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('DISTINCT');
      expect(query).not.toContain('INTERSECT');
    });

    test('lève une erreur pour un fieldName invalide', async () => {
      const loader = createCrossDatabaseSelectOptions();
      await expect(
        loader.load({
          fieldName: 'bad field!',
          catalogs: ['db1'],
          limit: 50,
        } satisfies CrossDatabaseSelectParams),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    });
  });
});
