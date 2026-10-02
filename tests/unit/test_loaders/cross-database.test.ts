/**
 * Unit tests for CrossDatabaseLoader (src/loaders/cross-database.ts).
 *
 * Verifies the comparison of a measure across two datasets (each side
 * aggregated by the join fields before the join, numeric coercion, null
 * handling, total order), the comparison of several aggregates (SQL of
 * getAggregates per side, four output columns per aggregate), and cross-catalog
 * select options.
 *
 * Note: the fact table carries the labels, so no table is consulted before the
 * comparison itself — each loader issues exactly its main query and its count
 * query, which the mocked results follow in that order.
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import {
  makeLoaderConfig,
  makePool,
  makeExtendedConnection,
  makeDatabaseManager,
} from '../../helpers/mocks.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Paramètres pour la comparaison d'une mesure entre deux datasets. */
interface CompareFactsParams {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  joinFields: string[];
  measure: string;
  aggregation: string;
  labelFieldA?: string | null;
  labelFieldB?: string | null;
  limit: number;
  offset: number;
  sort: Array<{ field: string; order: string }>;
}

/** Colonne de groupe résolue. */
interface Group {
  field: string;
  grain: string | null;
  truncation: string | null;
  labelField: string | null;
}

/** Côté d'une comparaison d'agrégats. */
interface Side {
  groups: Group[];
  aggregates: Array<{ measure: string; aggregation: string; alias: string }>;
}

/** Paramètres pour la comparaison de plusieurs agrégats entre deux datasets. */
interface CompareAggregatedParams {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  sideA: Side;
  sideB: Side;
  sort: Array<{ by: string; order: string }>;
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
const mockConnection = makeExtendedConnection();
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

// ─── Fabriques de paramètres ──────────────────────────────────────────────────

/**
 * Parameters of compareFacts, value summed by default.
 *
 * @param extra - Fields overriding the defaults.
 * @returns The parameters.
 */
const factsParams = (extra: Partial<CompareFactsParams> = {}): CompareFactsParams => ({
  catalogA: 'db_a',
  catalogB: 'db_b',
  joinFields: ['country'],
  measure: 'value',
  aggregation: 'SUM',
  limit: 10,
  offset: 0,
  sort: [],
  ...extra,
});

/**
 * One resolved side grouping by the given fields and summing value.
 *
 * @param fields - Group columns.
 * @param labelField - Label column of the first group column, if any.
 * @returns The side.
 */
const side = (fields: string[], labelField: string | null = null): Side => ({
  groups: fields.map((field, i) => ({
    field,
    grain: null,
    truncation: null,
    labelField: i === 0 ? labelField : null,
  })),
  aggregates: [{ measure: 'value', aggregation: 'SUM', alias: 'value_sum' }],
});

/**
 * Parameters of compareAggregatedFacts grouping by country.
 *
 * @param extra - Fields overriding the defaults.
 * @returns The parameters.
 */
const aggregatedParams = (
  extra: Partial<CompareAggregatedParams> = {},
): CompareAggregatedParams => ({
  catalogA: 'db_a',
  catalogB: 'db_b',
  sideA: side(['country']),
  sideB: side(['country']),
  sort: [{ by: 'country', order: 'ASC' }],
  limit: 10,
  offset: 0,
  ...extra,
});

/** Page returned by the mocked getWithMetadata. */
const PAGE = {
  columns: ['country', 'value_sum_a', 'value_sum_b', 'value_sum_delta', 'value_sum_delta_pct'],
  columnTypes: ['VARCHAR', 'DOUBLE', 'DOUBLE', 'DOUBLE', 'DOUBLE'],
  data: [
    {
      country: 'France',
      value_sum_a: 100,
      value_sum_b: 120,
      value_sum_delta: 20,
      value_sum_delta_pct: 20,
    },
  ],
  metadata: { extents: { value_sum_a: [100, 100] } },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CrossDatabaseLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Comparaison d'une mesure ──────────────────────────────────────────────

  describe('createCompareFacts', () => {
    test('crée un DataLoader valide', () => {
      const loader = createCompareFacts();
      expect(loader).toBeDefined();
      expect(typeof loader.load).toBe('function');
    });

    test('retourne les données de comparaison et la pagination', async () => {
      const rows: CompareRow[] = [
        { key: '1', valueA: 100, valueB: 120, delta: 20, deltaPercent: 20 },
      ];
      mockConnection.all.mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total: 1 }]);

      const result = (await createCompareFacts().load(factsParams())) as Record<string, unknown>;

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('hasNextPage', false);
      expect(result).toHaveProperty('currentPage', 1);
      expect(result).toHaveProperty('totalPages', 1);
    });

    test('agrège chaque côté par les champs de jointure AVANT la jointure', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await createCompareFacts().load(factsParams({ measure: 'weight_kg', aggregation: 'AVG' }));

      const query = mockConnection.all.mock.calls[0][0] as string;
      // Côtés : SELECT d'agrégats de getAggregates, une ligne par clé
      expect(query).toContain(
        'a AS (SELECT "country" AS "country", AVG("weight_kg") AS "_compared_value" ' +
          'FROM "db_a"."main"."fact_table" GROUP BY "country")',
      );
      expect(query).toContain('FROM "db_b"."main"."fact_table" GROUP BY "country"');
      // Jointure des côtés agrégés, clés alignées en VARCHAR
      expect(query).toContain(
        'FROM a JOIN b ON CAST(a."country" AS VARCHAR) = CAST(b."country" AS VARCHAR)',
      );
      expect(query).not.toContain('"value"');
    });

    test('le comptage joint des côtés réduits aux clés', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await createCompareFacts().load(factsParams());

      const count = mockConnection.all.mock.calls[1][0] as string;
      expect(count).toContain('SELECT COUNT(*) AS total');
      expect(count).toContain('GROUP BY "country"');
      expect(count).not.toContain('SUM(');
    });

    test('plusieurs joinFields : clé concaténée, départage par chaque champ', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await createCompareFacts().load(
        factsParams({
          joinFields: ["zone d'emploi", 'Année'],
          sort: [{ field: 'delta', order: 'DESC' }],
        }),
      );

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain(
        `CONCAT(CAST(a."zone d'emploi" AS VARCHAR), '::', CAST(a."Année" AS VARCHAR)) AS key`,
      );
      expect(query).toContain(`GROUP BY "zone d'emploi", "Année"`);
      expect(query).toContain(
        `CAST(a."zone d'emploi" AS VARCHAR) = CAST(b."zone d'emploi" AS VARCHAR) AND ` +
          'CAST(a."Année" AS VARCHAR) = CAST(b."Année" AS VARCHAR)',
      );
      // Ordre total : tri client puis chaque clé
      expect(query).toContain('ORDER BY "delta" DESC, _k_0 ASC, _k_1 ASC');
    });

    test('sans tri explicite, ordonné par les clés', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await createCompareFacts().load(factsParams({ limit: 5, offset: 10 }));

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toMatch(/ORDER BY _k_0 ASC\s+LIMIT 5 OFFSET 10/);
    });

    test('libellé de la clé : ANY_VALUE de chaque côté puis COALESCE', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await createCompareFacts().load(
        factsParams({ joinFields: ['nc8'], labelFieldA: 'nc8_en', labelFieldB: 'nc8_fr' }),
      );

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('ANY_VALUE("nc8_en") AS "nc8__label"');
      expect(query).toContain('ANY_VALUE("nc8_fr") AS "nc8__label"');
      expect(query).toContain('COALESCE(a."nc8__label", b."nc8__label") AS keyLabel');
    });

    test('convertit les valeurs numériques et préserve les null', async () => {
      mockConnection.all
        .mockResolvedValueOnce([
          { key: '42', valueA: '100.5', valueB: 120n, delta: '19.5', deltaPercent: null },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const result = (await createCompareFacts().load(factsParams())) as {
        data: CompareResult[];
      };

      expect(result.data[0]).toEqual({
        key: '42',
        keyLabel: null,
        valueA: 100.5,
        valueB: 120,
        delta: 19.5,
        deltaPercent: null,
      });
    });

    test('une erreur DuckDB rejette la clé au lieu de renvoyer null', async () => {
      mockConnection.all
        .mockRejectedValueOnce(new Error('IO Error: catalog unreachable'))
        .mockResolvedValueOnce([{ total: 0 }]);

      await expect(createCompareFacts().load(factsParams())).rejects.toThrow(
        'IO Error: catalog unreachable',
      );
    });

    test('supporte les requêtes cross-schéma dans un même catalogue', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await createCompareFacts().load(
        factsParams({ catalogB: 'db_a', schemaA: 'schema_a', schemaB: 'schema_b' }),
      );

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('"db_a"."schema_a"."fact_table"');
      expect(query).toContain('"db_a"."schema_b"."fact_table"');
      expect(query).not.toContain('dim_');
    });

    test('ne lit aucune métadonnée avant de comparer', async () => {
      mockConnection.all
        .mockResolvedValueOnce([
          { key: 'France', valueA: 1, valueB: 2, delta: 1, deltaPercent: 100 },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      await createCompareFacts().load(factsParams());

      // Deux requêtes seulement : la comparaison et son comptage
      expect(mockConnection.all).toHaveBeenCalledTimes(2);
      const queries = mockConnection.all.mock.calls.map((call) => call[0] as string);
      expect(queries.some((query) => query.includes('.metadata'))).toBe(false);
    });
  });

  // ── Comparaison de plusieurs agrégats ─────────────────────────────────────

  describe('createCompareAggregatedFacts', () => {
    test('crée un DataLoader valide', () => {
      expect(createCompareAggregatedFacts()).toBeDefined();
    });

    test('renvoie la page, ses types et extents, et le nombre de groupes', async () => {
      mockConnection.getWithMetadata.mockResolvedValueOnce(PAGE);
      mockConnection.all.mockResolvedValueOnce([{ total: 7 }]);

      const result = await createCompareAggregatedFacts().load(aggregatedParams());

      expect(result).toEqual({
        columns: PAGE.columns,
        columnTypes: PAGE.columnTypes,
        data: PAGE.data,
        extents: PAGE.metadata.extents,
        total: 7,
      });
    });

    test('quatre colonnes par agrégat sur des côtés agrégés par le SQL de getAggregates', async () => {
      mockConnection.getWithMetadata.mockResolvedValueOnce(PAGE);
      mockConnection.all.mockResolvedValueOnce([{ total: 1 }]);

      await createCompareAggregatedFacts().load(
        aggregatedParams({
          sort: [
            { by: 'value_sum_delta', order: 'DESC' },
            { by: 'country', order: 'ASC' },
          ],
          limit: 5,
          offset: 15,
        }),
      );

      const query = mockConnection.getWithMetadata.mock.calls[0][0] as string;
      expect(query).toContain(
        'a AS (SELECT "country" AS "country", SUM("value") AS "value_sum" ' +
          'FROM "db_a"."main"."fact_table" GROUP BY "country")',
      );
      expect(query).toContain('a."value_sum" AS "value_sum_a"');
      expect(query).toContain('b."value_sum" AS "value_sum_b"');
      expect(query).toContain('b."value_sum" - a."value_sum" AS "value_sum_delta"');
      expect(query).toContain(
        'CASE WHEN a."value_sum" IS NOT NULL AND a."value_sum" != 0 ' +
          'THEN (b."value_sum" - a."value_sum") / a."value_sum" * 100.0 END AS "value_sum_delta_pct"',
      );
      // Groupes NULL appariés, clés alignées en VARCHAR
      expect(query).toContain(
        'FROM a JOIN b ON CAST(a."country" AS VARCHAR) IS NOT DISTINCT FROM CAST(b."country" AS VARCHAR)',
      );
      expect(query).toMatch(/ORDER BY "value_sum_delta" DESC, "country" ASC\s+LIMIT 5 OFFSET 15/);
    });

    test('libellé : COALESCE des seuls côtés qui en ont un', async () => {
      mockConnection.getWithMetadata.mockResolvedValueOnce(PAGE);
      mockConnection.all.mockResolvedValueOnce([{ total: 1 }]);

      await createCompareAggregatedFacts().load(
        aggregatedParams({ sideA: side(['nc8']), sideB: side(['nc8'], 'nc8_fr') }),
      );

      const query = mockConnection.getWithMetadata.mock.calls[0][0] as string;
      expect(query).toContain('COALESCE(b."nc8__label") AS "nc8__label"');
      expect(query).not.toContain('a."nc8__label"');
    });

    test('sans groupe : produit croisé de deux lignes, total 1 sans comptage', async () => {
      mockConnection.getWithMetadata.mockResolvedValueOnce(PAGE);

      const result = (await createCompareAggregatedFacts().load(
        aggregatedParams({ sideA: side([]), sideB: side([]), sort: [] }),
      )) as { total: number };

      const query = mockConnection.getWithMetadata.mock.calls[0][0] as string;
      expect(query).toContain('FROM a CROSS JOIN b');
      expect(query).not.toContain('ORDER BY');
      expect(result.total).toBe(1);
      expect(mockConnection.all).not.toHaveBeenCalled();
    });

    test('supporte les requêtes cross-schéma dans un même catalogue', async () => {
      mockConnection.getWithMetadata.mockResolvedValueOnce(PAGE);
      mockConnection.all.mockResolvedValueOnce([{ total: 1 }]);

      await createCompareAggregatedFacts().load(
        aggregatedParams({ catalogB: 'db_a', schemaA: 'schema_a', schemaB: 'schema_b' }),
      );

      const query = mockConnection.getWithMetadata.mock.calls[0][0] as string;
      expect(query).toContain('"db_a"."schema_a"."fact_table"');
      expect(query).toContain('"db_a"."schema_b"."fact_table"');
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
      expect(query).toContain('CAST("country" AS VARCHAR)');
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

    test('quote le fieldName (contrôlé contre metadata par le resolver)', async () => {
      mockConnection.all.mockResolvedValueOnce([]);

      const loader = createCrossDatabaseSelectOptions();
      await loader.load({
        fieldName: 'taux chômage',
        catalogs: ['db1'],
        limit: 50,
      } satisfies CrossDatabaseSelectParams);

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('CAST("taux chômage" AS VARCHAR)');
      expect(query).toContain('WHERE "taux chômage" IS NOT NULL');
    });
  });
});
