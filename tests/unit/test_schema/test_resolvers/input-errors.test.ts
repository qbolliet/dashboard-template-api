/**
 * Acceptance tests of the input error contract (audit B2 / M7).
 *
 * Before the fix, the loaders turned every non-GraphQL error into null: the
 * client received `null` without `errors` for an out-of-bounds limit, an
 * unknown column or SUM on a VARCHAR. Each case below must now come back as a
 * BAD_USER_INPUT error, with the field null.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';
import type { GraphQLResult } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

/**
 * Asserts a BAD_USER_INPUT error and a null field.
 *
 * @param result - GraphQL response.
 * @param field - Root field expected to be null.
 * @param fragment - Substring expected in the error message.
 */
// Vérification d'un rejet BAD_USER_INPUT, champ à null
const expectBadInput = (result: GraphQLResult, field: string, fragment?: string): void => {
  expect(result.errors).toBeDefined();
  expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  if (fragment) expect(result.errors![0].message).toContain(fragment);
  expect(result.data?.[field] ?? null).toBeNull();
};

// ─── Pagination ───────────────────────────────────────────────────────────────

describe('pagination hors bornes', () => {
  test.each([
    ['limit: 5000', 'Limit cannot exceed 1000'],
    ['limit: -1', 'Limit must be a positive integer'],
    ['limit: 0', 'Limit must be a positive integer'],
    ['offset: -1', 'Offset must be a non-negative integer'],
  ])('getFactTableWithMetadata(%s) → BAD_USER_INPUT, data null', async (args, fragment) => {
    const result = await execute(server, {
      query: `query { getFactTableWithMetadata(${args}) { columns data } }`,
    });
    expectBadInput(result, 'getFactTableWithMetadata', fragment);
  });

  test('getAggregatedFacts(limit: 0) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query { getAggregatedFacts(groupBy: "country", measure: "value", limit: 0) { key } }`,
    });
    expectBadInput(result, 'getAggregatedFacts', 'Limit must be a positive integer');
  });

  test('compareFacts(offset: -1) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(catalogA: "default", catalogB: "macroeconomics", joinFields: ["country"], offset: -1) {
          total
        }
      }`,
    });
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('Offset must be a non-negative integer');
  });

  test('getSelectOptions(limit: 5000) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query { getSelectOptions(fieldName: "country", limit: 5000) { value } }`,
    });
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('Limit cannot exceed 1000');
  });
});

// ─── Colonnes inconnues ───────────────────────────────────────────────────────

describe('colonnes contrôlées contre metadata', () => {
  test('getFactTable(fields: ["nope"]) → BAD_USER_INPUT nommant "nope"', async () => {
    const result = await execute(server, {
      query: `query { getFactTable(fields: ["nope"]) { total } }`,
    });
    expectBadInput(result, 'getFactTable', '"nope"');
  });

  test('getFactTable(sort: [{ field: "nope" }]) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query { getFactTable(sort: [{ field: "nope", order: DESC }]) { total } }`,
    });
    expectBadInput(result, 'getFactTable', 'Unknown sort column(s): "nope"');
  });

  test('getAggregatedFacts(groupBy inconnu) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query { getAggregatedFacts(groupBy: "nope", measure: "value") { key } }`,
    });
    expectBadInput(result, 'getAggregatedFacts', 'Unknown groupBy column(s): "nope"');
  });

  test('getAggregatedFacts(measure: "indicator", aggregation: SUM) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(groupBy: "country", measure: "indicator", aggregation: SUM) { key }
      }`,
    });
    expectBadInput(result, 'getAggregatedFacts', 'requires a numeric measure');
  });

  test('compareFacts(joinFields inconnus) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(catalogA: "default", catalogB: "macroeconomics", joinFields: ["nope"]) { total }
      }`,
    });
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('Unknown joinField (default.main) column(s)');
  });

  test('compareFacts(sort hors colonnes projetées) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(
          catalogA: "default", catalogB: "macroeconomics", joinFields: ["country"]
          sort: [{ field: "country", order: ASC }]
        ) { total }
      }`,
    });
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('Invalid sort field(s): "country"');
  });

  test('crossDatabaseSelectOptions(fieldName inconnu) → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query {
        crossDatabaseSelectOptions(fieldName: "nope", catalogs: ["default", "macroeconomics"]) {
          value
        }
      }`,
    });
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('Unknown fieldName');
  });
});

// ─── MATCHES (RE2) ────────────────────────────────────────────────────────────

describe('MATCHES et RE2', () => {
  /**
   * Runs getFactTable with a single MATCHES criterion on `country`.
   *
   * @param pattern - Regular expression.
   * @returns GraphQL response.
   */
  const matching = (pattern: string): Promise<GraphQLResult> =>
    execute(server, {
      query: `query Q($f: FilterNode) { getFactTable(structuredFilters: $f, limit: 1) { total } }`,
      variables: {
        f: {
          children: [{ criterion: { variable: 'country', operation: 'MATCHES', value: pattern } }],
        },
      },
    });

  test('(?<=a)b → BAD_USER_INPUT avant toute requête', async () => {
    expectBadInput(await matching('(?<=a)b'), 'getFactTable', 'lookbehind');
  });

  test('une syntaxe refusée par DuckDB (RE2) → BAD_USER_INPUT, jamais null silencieux', async () => {
    expectBadInput(await matching('a++'), 'getFactTable', 'Invalid Input Error');
  });

  test('(?i) — valide en RE2, refusé par RegExp — est accepté', async () => {
    const result = await matching('(?i)^FRANCE$');
    expect(result.errors).toBeUndefined();
    expect((result.data!.getFactTable as { total: number }).total).toBeGreaterThan(0);
  });
});
