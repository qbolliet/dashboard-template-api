/**
 * Integration tests of the NULL-safety of getAggregates, on the real test
 * catalogs.
 *
 * The geography schema carries the cases that used to be distorted: a group
 * whose measure is entirely NULL (AVG must be null, not 0), a NULL group key
 * (null, not the string "null"), MIN/MAX of a date (ISO dates), an integer sum
 * beyond 2^53 (exact decimal string), a NULL group that COUNT(DISTINCT) would
 * leave out of the total, and groups tied on their aggregated value.
 * Aggregations incompatible with the type of the measure are rejected as
 * BAD_USER_INPUT.
 */

import { ApolloServer } from '@apollo/server';
import { clearAggregatedCache, ensureSetup, getServer, execute } from './helpers.js';
import type { GraphQLResult } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
  await clearAggregatedCache();
}, 60000);

// ─── Interfaces et fonctions utilitaires ──────────────────────────────────────

/** Payload of getAggregates, as selected by these tests. */
interface AggregatePayload {
  data: Record<string, unknown>[];
  total: number;
  hasNextPage: boolean;
  groupBy: { name: string; extent: unknown }[];
  aggregates: { alias: string; extent: unknown }[];
}

// Communes du schéma geography, groupe NULL compris (Saône-et-Loire sans commune)
const COMMUNES = ['Beaune', 'Dijon', 'Meaux', 'Melun', 'Montpellier', 'Paris', null];

/**
 * Runs getAggregates with the given arguments.
 *
 * @param args - GraphQL arguments, already formatted.
 * @returns The GraphQL result.
 */
// Exécution de getAggregates
const aggregate = (args: string): Promise<GraphQLResult> =>
  execute(server, {
    query: `query {
      getAggregates(${args}) {
        data total hasNextPage
        groupBy { name extent }
        aggregates { alias extent }
      }
    }`,
  });

/**
 * Runs getAggregates and returns its payload, failing on any error.
 *
 * @param args - GraphQL arguments, already formatted.
 * @returns The payload.
 */
// Résultat sans erreur admise
const payloadOf = async (args: string): Promise<AggregatePayload> => {
  const result = await aggregate(args);
  expect(result.errors).toBeUndefined();
  return result.data!.getAggregates as AggregatePayload;
};

/**
 * Asserts a BAD_USER_INPUT error on getAggregates.
 *
 * @param result - GraphQL response.
 * @param fragment - Substring expected in the error message.
 */
// Rejet BAD_USER_INPUT, champ à null
const expectBadInput = (result: GraphQLResult, fragment: string): void => {
  expect(result.errors).toBeDefined();
  expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  expect(result.errors![0].message).toContain(fragment);
  expect(result.data?.getAggregates ?? null).toBeNull();
};

// ─── Valeurs NULL et non numériques ───────────────────────────────────────────

describe('valeurs agrégées gardées telles que les rend le convertisseur JSON', () => {
  test('AVG d’un groupe entièrement NULL vaut null, pas 0', async () => {
    const { data } = await payloadOf(
      'schema: "geography", groupBy: [{ field: "departement" }], aggregates: [{ measure: "density", aggregation: AVG }], limit: 20',
    );
    const byKey = new Map(data.map((row) => [row.departement, row.density_avg]));

    // Saône-et-Loire ne descend pas au niveau communal : densité NULL sur ses lignes
    expect(byKey.get('Saône-et-Loire')).toBeNull();
    expect(typeof byKey.get('Paris')).toBe('number');
  });

  test('la clé NULL est null, pas la chaîne "null"', async () => {
    const { data } = await payloadOf(
      'schema: "geography", groupBy: [{ field: "commune" }], aggregates: [{ measure: "population", aggregation: SUM }], limit: 20',
    );

    expect(data.map((row) => row.commune)).toContain(null);
    expect(data.map((row) => row.commune)).not.toContain('null');
    expect(data.find((row) => row.commune === null)!.row_count).toBe(2);
  });

  test('MAX et MIN d’une date renvoient des dates ISO, sans erreur', async () => {
    const { data, aggregates } = await payloadOf(
      `schema: "geography", groupBy: [{ field: "region" }],
       aggregates: [{ measure: "date", aggregation: MAX }, { measure: "date", aggregation: MIN }], limit: 20`,
    );

    expect(data).toHaveLength(3);
    expect(data.every((row) => row.date_max === '2024-01-01')).toBe(true);
    expect(data.every((row) => row.date_min === '2023-01-01')).toBe(true);
    expect(aggregates[0].extent).toEqual(['2024-01-01', '2024-01-01']);
  });

  test('SUM d’un BIGINT au-delà de 2^53 reste une chaîne décimale exacte', async () => {
    const { data } = await payloadOf(
      'schema: "geography", groupBy: [{ field: "region" }], aggregates: [{ measure: "budget", aggregation: SUM }], limit: 20',
    );

    for (const row of data) {
      expect(typeof row.budget_sum).toBe('string');
      expect(row.budget_sum).toMatch(/^\d+$/);
    }
  });

  test('les groupes NULL ne faussent pas les bornes de la page', async () => {
    const { data, aggregates, groupBy } = await payloadOf(
      'schema: "geography", groupBy: [{ field: "departement" }], aggregates: [{ measure: "density", aggregation: AVG }], limit: 20',
    );
    const values = data
      .map((row) => row.density_avg)
      .filter((value): value is number => value !== null);

    expect(aggregates[0].extent).toEqual([Math.min(...values), Math.max(...values)]);
    // Colonne de groupe texte : pas d'extent
    expect(groupBy[0].extent).toBeNull();
  });
});

// ─── Résultat vide ────────────────────────────────────────────────────────────

describe('agrégat sur un résultat vide', () => {
  const EMPTY_FILTER =
    'structuredFilters: { children: [{ criterion: { variable: "region", operation: EQ, value: "Nulle part" } }] }';

  test('avec groupBy : aucune ligne, total 0, extents null', async () => {
    const { data, total, hasNextPage, aggregates } = await payloadOf(
      `schema: "geography", groupBy: [{ field: "region" }], aggregates: [{ measure: "population" }], ${EMPTY_FILTER}`,
    );

    expect(data).toEqual([]);
    expect(total).toBe(0);
    expect(hasNextPage).toBe(false);
    expect(aggregates[0].extent).toBeNull();
  });

  test('sans groupBy : une ligne, agrégat null et row_count 0', async () => {
    const { data, total } = await payloadOf(
      `schema: "geography", aggregates: [{ measure: "population" }], ${EMPTY_FILTER}`,
    );

    expect(total).toBe(1);
    expect(data).toEqual([{ population_sum: null, row_count: 0 }]);
  });
});

// ─── Pagination des groupes ───────────────────────────────────────────────────

describe('pagination des groupes', () => {
  test('total compte le groupe NULL', async () => {
    const { total, hasNextPage } = await payloadOf(
      'schema: "geography", groupBy: [{ field: "commune" }], aggregates: [{ measure: "population" }], limit: 5',
    );

    // Six communes + le groupe NULL : COUNT(DISTINCT commune) en donnerait 6
    expect(total).toBe(COMMUNES.length);
    expect(hasNextPage).toBe(true);
  });

  test('deux pages successives de groupes ex æquo sont disjointes', async () => {
    // Deux dates par commune : COUNT vaut 2 pour chacun des sept groupes
    const pages: unknown[][] = [];
    for (let offset = 0; offset < COMMUNES.length; offset += 2) {
      const { data } = await payloadOf(
        `schema: "geography", groupBy: [{ field: "commune" }],
         aggregates: [{ measure: "population", aggregation: COUNT, alias: "n" }],
         sort: [{ by: "n", order: DESC }], limit: 2, offset: ${offset}`,
      );
      expect(data.every((row) => row.n === 2)).toBe(true);
      pages.push(data.map((row) => row.commune));
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
      'schema: "main", groupBy: [{ field: "country" }], aggregates: [{ measure: "notes", aggregation: SUM }]',
    );

    expectBadInput(result, 'Allowed aggregations: COUNT, MODE');
  });

  test('MIN sur un VARCHAR → BAD_USER_INPUT', async () => {
    const result = await aggregate(
      'schema: "main", groupBy: [{ field: "country" }], aggregates: [{ measure: "notes", aggregation: MIN }]',
    );

    expectBadInput(result, 'Aggregation MIN is not allowed on measure "notes" (VARCHAR)');
  });

  test('SUM sur un BOOLEAN → BAD_USER_INPUT', async () => {
    const result = await aggregate(
      'schema: "geography", groupBy: [{ field: "region" }], aggregates: [{ measure: "is_urban", aggregation: SUM }]',
    );

    expectBadInput(result, 'Allowed aggregations: COUNT, MODE');
  });

  test('AVG sur une date → BAD_USER_INPUT, MIN/MAX admis', async () => {
    const result = await aggregate(
      'schema: "geography", groupBy: [{ field: "region" }], aggregates: [{ measure: "date", aggregation: AVG }]',
    );

    expectBadInput(result, 'Allowed aggregations: MAX, MIN, COUNT, MODE');
  });

  test('un agrégat refusé fait échouer toute la requête', async () => {
    const result = await aggregate(
      `schema: "main", groupBy: [{ field: "country" }],
       aggregates: [{ measure: "value", aggregation: SUM }, { measure: "ingested_at", aggregation: AVG }]`,
    );

    expectBadInput(result, 'Aggregation AVG is not allowed on measure "ingested_at"');
  });

  test('MODE et COUNT sont admis sur toutes les familles', async () => {
    const mode = await payloadOf(
      'schema: "geography", groupBy: [{ field: "region" }], aggregates: [{ measure: "is_urban", aggregation: MODE }]',
    );
    const count = await payloadOf(
      'schema: "main", groupBy: [{ field: "country" }], aggregates: [{ measure: "notes", aggregation: COUNT }]',
    );

    expect(mode.data.every((row) => typeof row.is_urban_mode === 'boolean')).toBe(true);
    expect(count.data.every((row) => typeof row.notes_count === 'number')).toBe(true);
  });

  test('mesure non numérique sans defaultAggregation → BAD_USER_INPUT, pas de COUNT implicite', async () => {
    const result = await aggregate(
      'schema: "geography", groupBy: [{ field: "region" }], aggregates: [{ measure: "is_urban" }]',
    );

    expectBadInput(result, 'declares no defaultAggregation');
  });
});
