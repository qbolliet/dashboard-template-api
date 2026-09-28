/**
 * Integration tests of the NULL-safety of aggregated facts, on the real test
 * catalogs.
 *
 * The geography schema carries the three cases that used to be distorted by
 * the loader: a group whose measure is entirely NULL (AVG gave 0), a NULL group
 * key (it became the string "null") and MIN/MAX of a date (NaN, then a Float
 * serialization error). It also has a NULL group that COUNT(DISTINCT) left out
 * of the total, and groups tied on their aggregated value. Aggregations
 * incompatible with the type of the measure are rejected as BAD_USER_INPUT.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';
import { redis } from '../../../../src/cache/index.js';
import { createLoaders } from '../../../../src/loaders/index.js';
import type { GraphQLResult } from './helpers.js';
import type {
  AggregatedQueryParams,
  AggregatedWithCount,
} from '../../../../src/loaders/aggregated-facts.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
  await clearAggregatedCache();
}, 60000);

// ─── Interfaces et fonctions utilitaires ──────────────────────────────────────

/** One aggregated row as returned by the API. */
interface AggregatedRow {
  key: string | null;
  aggregatedValue: unknown;
  count: number;
}

/** Metadata of getAggregatedFactsWithMetadata, as returned by the API. */
interface AggregatedMetadata {
  count: number;
  keyExtent: unknown;
  valueExtent: unknown;
  statistics: { mean: number | null } | null;
}

// Communes du schéma geography, groupe NULL compris (Saône-et-Loire sans commune)
const COMMUNES = ['Beaune', 'Dijon', 'Meaux', 'Melun', 'Montpellier', 'Paris', null];

/**
 * Empties the Redis entries of the aggregated facts.
 *
 * Redis outlives the test data regenerated at every run: an entry written by
 * a previous run, in the former result shape, would answer without reaching
 * the loader. Same key-prefix handling as field-stats.test.ts; with Redis down
 * the loader runs on every call and there is nothing to clear.
 */
// Vidage du cache des agrégats, sensible au préfixe de clés d'ioredis
async function clearAggregatedCache(): Promise<void> {
  try {
    const prefix =
      (redis as unknown as { options: { keyPrefix?: string } }).options.keyPrefix ?? '';
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}aggregated-facts:*`,
        'COUNT',
        100,
      );
      if (keys.length > 0) await redis.del(...keys.map((key) => key.slice(prefix.length)));
      cursor = next;
    } while (cursor !== '0');
  } catch {
    // Redis indisponible : aucun cache à vider
  }
}

/**
 * Runs getAggregatedFacts with the given arguments.
 *
 * @param args - GraphQL arguments, already formatted.
 * @returns The GraphQL result.
 */
// Exécution de getAggregatedFacts
const aggregate = (args: string): Promise<GraphQLResult> =>
  execute(server, {
    query: `query { getAggregatedFacts(${args}) { key aggregatedValue count } }`,
  });

/**
 * Runs getAggregatedFacts and returns its rows, failing on any error.
 *
 * @param args - GraphQL arguments, already formatted.
 * @returns The aggregated rows.
 */
// Lignes agrégées, sans erreur admise
const rowsOf = async (args: string): Promise<AggregatedRow[]> => {
  const result = await aggregate(args);
  expect(result.errors).toBeUndefined();
  return result.data!.getAggregatedFacts as AggregatedRow[];
};

/**
 * Runs getAggregatedFactsWithMetadata and returns its payload, failing on any error.
 *
 * @param args - GraphQL arguments, already formatted.
 * @returns The rows and their metadata.
 */
// Lignes et métadonnées, sans erreur admise
const withMetadata = async (
  args: string,
): Promise<{ data: AggregatedRow[]; metadata: AggregatedMetadata }> => {
  const result = await execute(server, {
    query: `query {
      getAggregatedFactsWithMetadata(${args}) {
        data { key aggregatedValue count }
        metadata { count keyExtent valueExtent statistics { mean } }
      }
    }`,
  });
  expect(result.errors).toBeUndefined();
  return result.data!.getAggregatedFactsWithMetadata as {
    data: AggregatedRow[];
    metadata: AggregatedMetadata;
  };
};

/**
 * Asserts a BAD_USER_INPUT error on getAggregatedFacts.
 *
 * @param result - GraphQL response.
 * @param fragment - Substring expected in the error message.
 */
// Rejet BAD_USER_INPUT, champ à null
const expectBadInput = (result: GraphQLResult, fragment: string): void => {
  expect(result.errors).toBeDefined();
  expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  expect(result.errors![0].message).toContain(fragment);
  expect(result.data?.getAggregatedFacts ?? null).toBeNull();
};

// ─── Valeurs NULL et non numériques ───────────────────────────────────────────

describe('valeurs agrégées gardées telles que les rend le convertisseur JSON', () => {
  test('AVG d’un groupe entièrement NULL vaut null, pas 0', async () => {
    const rows = await rowsOf(
      'schema: "geography", groupBy: "departement", measure: "density", aggregation: AVG, limit: 20',
    );
    const byKey = new Map(rows.map((row) => [row.key, row.aggregatedValue]));

    // Saône-et-Loire ne descend pas au niveau communal : densité NULL sur ses lignes
    expect(byKey.get('Saône-et-Loire')).toBeNull();
    expect(typeof byKey.get('Paris')).toBe('number');
  });

  test('la clé NULL est null, pas la chaîne "null"', async () => {
    const rows = await rowsOf(
      'schema: "geography", groupBy: "commune", measure: "population", aggregation: SUM, limit: 20',
    );

    expect(rows.map((row) => row.key)).toContain(null);
    expect(rows.map((row) => row.key)).not.toContain('null');
    expect(rows.find((row) => row.key === null)!.count).toBe(2);
  });

  test('MAX et MIN d’une date renvoient des dates ISO, sans erreur', async () => {
    const max = await rowsOf(
      'schema: "geography", groupBy: "region", measure: "date", aggregation: MAX, limit: 20',
    );
    const min = await rowsOf(
      'schema: "geography", groupBy: "region", measure: "date", aggregation: MIN, limit: 20',
    );

    expect(max).toHaveLength(3);
    expect(max.every((row) => row.aggregatedValue === '2024-01-01')).toBe(true);
    expect(min.every((row) => row.aggregatedValue === '2023-01-01')).toBe(true);
  });

  test('MAX d’une date avec métadonnées : valueExtent ISO, pas de statistiques', async () => {
    const { metadata } = await withMetadata(
      'schema: "geography", groupBy: "region", measure: "date", aggregation: MAX, limit: 20',
    );

    expect(metadata.valueExtent).toEqual(['2024-01-01', '2024-01-01']);
    expect(metadata.statistics).toBeNull();
  });

  test('SUM d’un BIGINT au-delà de 2^53 reste une chaîne décimale exacte', async () => {
    const rows = await rowsOf(
      'schema: "geography", groupBy: "region", measure: "budget", aggregation: SUM, limit: 20',
    );

    for (const row of rows) {
      expect(typeof row.aggregatedValue).toBe('string');
      expect(row.aggregatedValue).toMatch(/^\d+$/);
    }
  });

  test('les groupes NULL ne faussent ni les bornes ni les statistiques', async () => {
    const { data, metadata } = await withMetadata(
      'schema: "geography", groupBy: "departement", measure: "density", aggregation: AVG, limit: 20',
    );
    const values = data
      .map((row) => row.aggregatedValue)
      .filter((value): value is number => value !== null);

    expect(metadata.valueExtent).toEqual([Math.min(...values), Math.max(...values)]);
    expect(metadata.statistics!.mean).toBeCloseTo(
      values.reduce((a, b) => a + b, 0) / values.length,
    );
  });
});

// ─── Résultat vide ────────────────────────────────────────────────────────────

describe('agrégat sur un résultat vide', () => {
  const EMPTY_FILTER =
    'structuredFilters: { children: [{ criterion: { variable: "region", operation: EQ, value: "Nulle part" } }] }';

  test('getAggregatedFacts renvoie une liste vide', async () => {
    const rows = await rowsOf(
      `schema: "geography", groupBy: "region", measure: "population", ${EMPTY_FILTER}`,
    );

    expect(rows).toEqual([]);
  });

  test('valueExtent et keyExtent sont null, pas [0, 0]', async () => {
    const { data, metadata } = await withMetadata(
      `schema: "geography", groupBy: "region", measure: "population", ${EMPTY_FILTER}`,
    );

    expect(data).toEqual([]);
    expect(metadata.count).toBe(0);
    expect(metadata.valueExtent).toBeNull();
    expect(metadata.keyExtent).toBeNull();
  });
});

// ─── Pagination des groupes ───────────────────────────────────────────────────

describe('pagination des groupes', () => {
  test('totalGroups compte le groupe NULL', async () => {
    const loaders = createLoaders('default', 'geography');
    const result = (await loaders.aggregatedFactsWithCount.load({
      where: null,
      groupBy: 'commune',
      measure: 'population',
      aggregation: 'SUM',
      valueFamily: 'numeric',
      labelField: null,
      limit: 5,
      offset: 0,
      sort: [],
    } as AggregatedQueryParams)) as AggregatedWithCount;

    // Six communes + le groupe NULL : COUNT(DISTINCT commune) en donnait 6
    expect(result.totalGroups).toBe(COMMUNES.length);
    expect(result.hasNextPage).toBe(true);
    expect(result.totalPages).toBe(2);
  });

  test('deux pages successives de groupes ex æquo sont disjointes', async () => {
    // Deux dates par commune : COUNT vaut 2 pour chacun des sept groupes
    const pages: (string | null)[][] = [];
    for (let offset = 0; offset < COMMUNES.length; offset += 2) {
      const rows = await rowsOf(
        `schema: "geography", groupBy: "commune", measure: "population", aggregation: COUNT,
         sort: [{ field: "aggregatedValue", order: DESC }], limit: 2, offset: ${offset}`,
      );
      expect(rows.every((row) => row.aggregatedValue === 2)).toBe(true);
      pages.push(rows.map((row) => row.key));
    }

    const keys = pages.flat();
    // Aucune clé répétée d'une page à l'autre, aucune perdue
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...COMMUNES].sort());
  });
});

// ─── Agrégation contrôlée selon la famille de type ────────────────────────────

describe('agrégation compatible avec le type de la mesure', () => {
  test('SUM sur un VARCHAR → BAD_USER_INPUT listant les agrégations permises', async () => {
    const result = await aggregate(
      'schema: "main", groupBy: "country", measure: "notes", aggregation: SUM',
    );

    expectBadInput(result, 'Allowed aggregations: COUNT, MODE');
  });

  test('MIN sur un VARCHAR → BAD_USER_INPUT', async () => {
    const result = await aggregate(
      'schema: "main", groupBy: "country", measure: "notes", aggregation: MIN',
    );

    expectBadInput(result, 'Aggregation MIN is not allowed on measure "notes" (VARCHAR)');
  });

  test('SUM sur un BOOLEAN → BAD_USER_INPUT', async () => {
    const result = await aggregate(
      'schema: "geography", groupBy: "region", measure: "is_urban", aggregation: SUM',
    );

    expectBadInput(result, 'Allowed aggregations: COUNT, MODE');
  });

  test('AVG sur une date → BAD_USER_INPUT, MIN/MAX admis', async () => {
    const result = await aggregate(
      'schema: "geography", groupBy: "region", measure: "date", aggregation: AVG',
    );

    expectBadInput(result, 'Allowed aggregations: MAX, MIN, COUNT, MODE');
  });

  test('MODE et COUNT sont admis sur toutes les familles', async () => {
    const mode = await rowsOf(
      'schema: "geography", groupBy: "region", measure: "is_urban", aggregation: MODE',
    );
    const count = await rowsOf(
      'schema: "main", groupBy: "country", measure: "notes", aggregation: COUNT',
    );

    expect(mode.every((row) => typeof row.aggregatedValue === 'boolean')).toBe(true);
    expect(count.every((row) => typeof row.aggregatedValue === 'number')).toBe(true);
  });

  test('mesure non numérique sans defaultAggregation → BAD_USER_INPUT, pas de COUNT implicite', async () => {
    const result = await aggregate('schema: "geography", groupBy: "region", measure: "is_urban"');

    expectBadInput(result, 'declares no defaultAggregation');
  });
});
