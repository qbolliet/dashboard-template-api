/**
 * Integration tests for the SQL types the database declares in metadata.sql_type.
 *
 * The database writes `DECIMAL` bare for a DECIMAL(p,s) column, and may write
 * TIME, INTERVAL or BLOB: the API must filter and aggregate the former, and list,
 * project, sort and describe the latter without ever raising — only a filter on
 * them is a client error. Uses the `default.no_primary_key` fixture: `amount` is
 * a DECIMAL(10,2) declared "DECIMAL" (values 0, 1.25, 2.5 … 298.75, one per row),
 * `slot` a TIME, `label` a VARCHAR shared by 20 rows each.
 */

import { ApolloServer } from '@apollo/server';
import { catalogResolvers } from '../../../../src/schema/resolvers/catalog.js';
import type { GraphQLContext } from '../../../../src/schema/resolvers/types.js';
import { ensureSetup, getServer, execute } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/** Ligne de getFactTable : coordonnées et mesures nommées. */
interface FactRow {
  keys: Array<{ name: string; value: unknown }>;
  measures: Array<{ name: string; value: unknown }>;
}

/**
 * Builds the `structuredFilters` argument of a single criterion.
 *
 * @param variable - Column name.
 * @param operation - FilterOperation enum value.
 * @param value - GraphQL literal of the criterion value.
 * @returns The argument text, without surrounding punctuation.
 */
// Filtre à une seule feuille
const filterOn = (variable: string, operation: string, value: string): string =>
  `structuredFilters: { children: [{ criterion: { variable: "${variable}", operation: ${operation}, value: ${value} } }] }`;

/**
 * Reads the total and the `amount` values of the rows a filter selects.
 *
 * @param filter - Argument text from {@link filterOn}.
 * @returns The GraphQL result, for the caller to assert on.
 */
// Lecture du total et des montants sélectionnés par un filtre
const select = (filter: string) =>
  execute(server, {
    query: `query {
      getFactTable(schema: "no_primary_key", ${filter}, limit: 300) {
        total
        data { measures { name value } }
      }
    }`,
  });

// ─── DECIMAL déclaré « DECIMAL » ──────────────────────────────────────────────

describe('DECIMAL declared without precision', () => {
  test('BETWEEN is accepted and selects the rows of the range', async () => {
    const result = await select(filterOn('amount', 'BETWEEN', '{ min: 100, max: 110 }'));

    expect(result.errors).toBeUndefined();
    const page = result.data!.getFactTable as { total: number; data: FactRow[] };
    // 100, 101.25 … 110 : neuf multiples de 1.25
    expect(page.total).toBe(9);
    const amounts = page.data
      .map((row) => Number(row.measures.find((m) => m.name === 'amount')?.value))
      .sort((a, b) => a - b);
    expect(amounts).toEqual([100, 101.25, 102.5, 103.75, 105, 106.25, 107.5, 108.75, 110]);
  });

  test('accepts bounds sent as numeric strings', async () => {
    const result = await select(filterOn('amount', 'BETWEEN', '{ min: "100", max: "101.25" }'));

    expect(result.errors).toBeUndefined();
    expect((result.data!.getFactTable as { total: number }).total).toBe(2);
  });

  test('does not round the value to the default DECIMAL(18,3) before comparing', async () => {
    // 1.2500001 ≠ 1.25 : un CAST en DECIMAL(18,3) l'arrondirait à 1.250 et
    // sélectionnerait à tort la ligne à 1.25
    const near = await select(filterOn('amount', 'EQ', '1.2500001'));
    const exact = await select(filterOn('amount', 'EQ', '1.25'));

    expect(near.errors).toBeUndefined();
    expect((near.data!.getFactTable as { total: number }).total).toBe(0);
    expect((exact.data!.getFactTable as { total: number }).total).toBe(1);
  });

  test('is numeric for aggregations: SUM is allowed and exact', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "no_primary_key", groupBy: "label", measure: "amount", aggregation: SUM) {
          key aggregatedValue
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const groups = result.data!.getAggregatedFacts as Array<{
      key: string;
      aggregatedValue: number;
    }>;
    expect(groups).toHaveLength(12);
    // item-00 : amounts 1.25 × (0, 12, 24 … 228) = 1.25 × 12 × 190
    expect(groups.find((group) => group.key === 'item-00')?.aggregatedValue).toBe(2850);
  });

  test('the default aggregation of the measure applies (SUM)', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "no_primary_key", groupBy: "quantity", measure: "amount") {
          key aggregatedValue
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getAggregatedFacts as unknown[]).toHaveLength(7);
  });
});

// ─── Types sans famille de filtre (TIME) ──────────────────────────────────────

describe('a column of the `other` family (TIME)', () => {
  test('a filter with a value on it is a BAD_USER_INPUT naming the type', async () => {
    const result = await select(filterOn('slot', 'EQ', '"08:00:00"'));

    expect(result.errors).toBeDefined();
    const [error] = result.errors!;
    expect(error.extensions?.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('unsupported SQL type "TIME"');
    expect(error.message).toContain('only IS_NULL and IS_NOT_NULL are allowed');
  });

  test('IS_NULL and IS_NOT_NULL are accepted and partition the rows', async () => {
    const byPresence = async (operation: string): Promise<number> => {
      const result = await execute(server, {
        query: `query {
          getFactTable(schema: "no_primary_key",
            structuredFilters: { children: [{ criterion: { variable: "slot", operation: ${operation} } }] },
            limit: 1) { total }
        }`,
      });
      expect(result.errors).toBeUndefined();
      return (result.data!.getFactTable as { total: number }).total;
    };

    const [nulls, present] = await Promise.all([byPresence('IS_NULL'), byPresence('IS_NOT_NULL')]);
    expect(present).toBeGreaterThan(0);
    expect(nulls + present).toBe(240);
  });

  test('a filter on another column of the same schema is unaffected', async () => {
    const result = await select(filterOn('label', 'EQ', '"item-03"'));

    expect(result.errors).toBeUndefined();
    expect((result.data!.getFactTable as { total: number }).total).toBe(20);
  });

  test('it is projected, serialized and sorted without error', async () => {
    const result = await execute(server, {
      query: `query {
        getFactTable(schema: "no_primary_key", fields: ["slot"], sort: [{ field: "slot", order: ASC }], limit: 5) {
          data { measures { name value } }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const rows = (result.data!.getFactTable as { data: FactRow[] }).data;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.measures[0]).toMatchObject({ name: 'slot' });
      expect(String(row.measures[0].value)).toMatch(/^\d{2}:\d{2}:\d{2}/);
    }
  });

  test('the page extents skip it and keep the numeric and date columns', async () => {
    const result = await execute(server, {
      query: `query {
        getFactTableWithMetadata(schema: "no_primary_key", limit: 240) {
          metadata { extents }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const { extents } = (
      result.data!.getFactTableWithMetadata as {
        metadata: { extents: Record<string, [unknown, unknown]> };
      }
    ).metadata;
    expect(extents.slot).toBeUndefined();
    // Le DECIMAL physique (DECIMAL(10,2)) garde son extent numérique
    expect(extents.amount).toEqual([0, 298.75]);
    expect(extents.quantity).toEqual([0, 6]);
    expect(extents.observed_on).toEqual(['2024-03-01', '2024-03-28']);
  });

  test('the per-column statistics are computed on every column', async () => {
    const result = await execute(server, {
      query: `query {
        getCatalogSchema(schema: "no_primary_key") { name stats { min max distinctCount nullCount } }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const fields = result.data!.getCatalogSchema as Array<{
      name: string;
      stats: { distinctCount: number; nullCount: number };
    }>;
    expect(fields.map((f) => f.name)).toEqual([
      'label',
      'observed_on',
      'amount',
      'slot',
      'quantity',
    ]);
    expect(fields.find((f) => f.name === 'amount')?.stats.distinctCount).toBe(240);
    expect(fields.find((f) => f.name === 'label')?.stats.distinctCount).toBe(12);
  });

  test('getFields filters by the exact declared type (TIME)', async () => {
    const result = await execute(server, {
      query: `query { getFields(schema: "no_primary_key", sqlType: "time") { value } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getFields).toEqual([{ value: 'slot' }]);
  });
});

// ─── getSharedFields : les types « other » ne s'apparient que s'ils sont identiques ─

describe('getSharedFields with types of the `other` family', () => {
  /** A categorical, non-label column of the given SQL type. */
  const column = (name: string, sqlType: string) => ({
    name,
    label: name,
    sqlType,
    isPrimaryKey: true,
    isCategorical: true,
    parentName: null,
    labelFor: null,
    labelFields: [],
  });

  test('pairs identical exotic types and equal families, never different exotic types', async () => {
    const rowsBySchema: Record<string, ReturnType<typeof column>[]> = {
      main: [
        column('t', 'TIME'),
        column('u', 'BLOB'),
        column('v', 'INTERVAL'),
        column('w', 'DECIMAL'),
        column('x', 'VARCHAR'),
      ],
      predictions: [
        column('t', 'TIME'),
        column('u', 'INTERVAL'),
        column('v', 'INTERVAL'),
        column('w', 'DECIMAL(10,2)'),
        column('x', 'TIME'),
      ],
    };
    const context = {
      loaders: {
        catalogMetadata: {
          load: async ({ schema }: { schema: string }) => rowsBySchema[schema],
        },
      },
    } as unknown as GraphQLContext;

    const shared = await catalogResolvers.Query.getSharedFields(
      null,
      {
        targets: [
          { catalog: 'default', schema: 'main' },
          { catalog: 'default', schema: 'predictions' },
        ],
      },
      context,
    );

    // t : TIME = TIME · v : INTERVAL = INTERVAL · w : DECIMAL et DECIMAL(10,2) sont numériques
    // u : BLOB ≠ INTERVAL · x : VARCHAR ≠ TIME (texte contre « other »)
    expect(shared).toEqual(['t', 'v', 'w']);
  });
});
