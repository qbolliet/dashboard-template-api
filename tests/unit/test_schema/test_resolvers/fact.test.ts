/**
 * Integration tests for the getFactTable, getFactTableWithMetadata resolvers,
 * and associated error handling and complex combined queries.
 *
 * Covers pagination, filter trees (FilterNode: AND/OR groups, typed
 * operations, BAD_USER_INPUT rejections), sorting, field selection,
 * dimension details, format options (OBJECTS/ARRAYS), SQL injection guards,
 * and multi-resolver single-request composition.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo réutilisé par tous les tests du fichier
let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Runs getFactTable with a filter tree passed as a variable and returns the
 * total, or the GraphQL errors.
 *
 * @param structuredFilters - Filter tree (FilterNode) or null.
 * @returns Total row count and errors of the response.
 */
// Exécution d'un comptage filtré via variables GraphQL
async function countWith(structuredFilters: unknown): Promise<{
  total?: number;
  errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }>;
}> {
  const result = await execute(server, {
    query: `
      query Count($f: FilterNode) {
        getFactTable(structuredFilters: $f, limit: 1, offset: 0) { total }
      }
    `,
    variables: { f: structuredFilters },
  });
  return {
    total: (result.data?.getFactTable as { total: number } | null | undefined)?.total,
    errors: result.errors as ReadonlyArray<{
      message: string;
      extensions?: Record<string, unknown>;
    }>,
  };
}

/**
 * Builds a filter tree leaf.
 *
 * @param variable - Column name.
 * @param operation - FilterOperation value.
 * @param value - Criterion value (omitted for IS_NULL / IS_NOT_NULL).
 * @param connector - Connector with the previous node.
 * @returns FilterNode leaf object.
 */
// Construction d'une feuille d'arbre de filtres
const leaf = (variable: string, operation: string, value?: unknown, connector?: 'AND' | 'OR') => ({
  ...(connector ? { connector } : {}),
  criterion: { variable, operation, ...(value !== undefined ? { value } : {}) },
});

// ─── Tests getFactTable ───────────────────────────────────────────────────────

describe('getFactTable', () => {
  test('returns paginated facts with all pagination fields', async () => {
    const query = `
      query {
        getFactTable(limit: 10, offset: 0) {
          data { measures { name value } }
          total
          hasNextPage
          currentPage
          totalPages
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const ft = result.data!.getFactTable as {
      data: unknown[];
      total: number;
      hasNextPage: boolean;
      currentPage: number;
      totalPages: number;
    };
    expect(Array.isArray(ft.data)).toBe(true);
    expect(ft.data.length).toBeLessThanOrEqual(10);
    expect(ft.total).toBeGreaterThan(0);
    expect(ft.currentPage).toBe(1);
    expect(typeof ft.hasNextPage).toBe('boolean');
    expect(ft.totalPages).toBeGreaterThan(0);
  });

  test('rejects the removed raw SQL filters argument', async () => {
    const query = `
      query {
        getFactTable(filters: "country = 1 AND indicator = 1", limit: 20, offset: 0) {
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain('Unknown argument "filters"');
  });

  test('applies a flat AND filter tree (inline literal)', async () => {
    const query = `
      query {
        getFactTable(
          structuredFilters: {
            children: [
              { criterion: { variable: "country", operation: EQ, value: 1 } }
              { connector: AND, criterion: { variable: "kind", operation: EQ, value: 1 } }
            ]
          }
          limit: 10
          offset: 0
        ) {
          data { measures { name value } }
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const ft = result.data!.getFactTable as { data: unknown[]; total: number };
    expect(Array.isArray(ft.data)).toBe(true);

    // Le filtre restreint le jeu de données
    const { total: unfiltered } = await countWith(null);
    expect(ft.total).toBeLessThanOrEqual(unfiltered!);
  });

  test('OR group is equivalent to IN, and parenthesized sub-groups combine with AND', async () => {
    const viaIn = await countWith({ children: [leaf('country', 'IN', [1, 2])] });
    const viaOr = await countWith({
      children: [leaf('country', 'EQ', 1), leaf('country', 'EQ', 2, 'OR')],
    });
    expect(viaIn.errors).toBeUndefined();
    expect(viaOr.errors).toBeUndefined();
    expect(viaOr.total).toBe(viaIn.total);

    // kind = 1 AND (country = 1 OR country = 2) ≡ kind = 1 AND country IN (1, 2)
    const grouped = await countWith({
      children: [
        leaf('kind', 'EQ', 1),
        { connector: 'AND', children: [leaf('country', 'EQ', 1), leaf('country', 'EQ', 2, 'OR')] },
      ],
    });
    const flat = await countWith({
      children: [leaf('kind', 'EQ', 1), leaf('country', 'IN', [1, 2], 'AND')],
    });
    expect(grouped.errors).toBeUndefined();
    expect(grouped.total).toBe(flat.total);
    expect(grouped.total!).toBeLessThanOrEqual(viaIn.total!);
  });

  test('negate on a leaf and on a group is the SQL complement', async () => {
    const inSet = await countWith({ children: [leaf('country', 'IN', [1, 2])] });
    const negatedLeaf = await countWith({
      children: [{ negate: true, ...leaf('country', 'IN', [1, 2]) }],
    });
    const negatedGroup = await countWith({
      children: [
        { negate: true, children: [leaf('country', 'EQ', 1), leaf('country', 'EQ', 2, 'OR')] },
      ],
    });
    const all = await countWith(null);

    expect(negatedLeaf.errors).toBeUndefined();
    expect(negatedGroup.errors).toBeUndefined();
    expect(negatedLeaf.total).toBe(negatedGroup.total);
    expect(inSet.total! + negatedLeaf.total!).toBe(all.total);
  });

  test('case-insensitive and regex operations work on a text column', async () => {
    const eq = await countWith({ children: [leaf('notes', 'EQ', 'actual')] });
    const ieq = await countWith({ children: [leaf('notes', 'IEQ', 'AcTuAl')] });
    const matches = await countWith({
      children: [leaf('notes', 'MATCHES', '^(actual|forecast)$')],
    });

    expect(ieq.errors).toBeUndefined();
    expect(matches.errors).toBeUndefined();
    expect(ieq.total).toBe(eq.total);
    expect(matches.total).toBeGreaterThanOrEqual(eq.total!);
    expect(matches.total).toBeGreaterThan(0);
  });

  test('NOT_IN is the complement of IN', async () => {
    const all = await countWith(null);
    const inSet = await countWith({ children: [leaf('country', 'IN', [1, 2])] });
    const notIn = await countWith({ children: [leaf('country', 'NOT_IN', [1, 2])] });
    expect(notIn.errors).toBeUndefined();
    expect(inSet.total! + notIn.total!).toBe(all.total);
  });

  test('filters on a measure column (numeric BETWEEN on value)', async () => {
    const result = await countWith({ children: [leaf('value', 'BETWEEN', { min: 0, max: 50 })] });
    const gte = await countWith({
      children: [leaf('value', 'GTE', 0), leaf('value', 'LTE', 50, 'AND')],
    });
    expect(result.errors).toBeUndefined();
    expect(result.total).toBe(gte.total);
  });

  test('filters a TIMESTAMP column with ISO 8601 dates', async () => {
    const all = await countWith(null);
    const between = await countWith({
      children: [leaf('date', 'BETWEEN', { min: '1900-01-01', max: '2200-12-31T23:59:59' })],
    });
    const before = await countWith({ children: [leaf('date', 'BEFORE', '1900-01-01')] });
    expect(between.errors).toBeUndefined();
    expect(before.errors).toBeUndefined();
    expect(between.total).toBe(all.total);
    expect(before.total).toBe(0);
  });

  test('IS_NULL / IS_NOT_NULL partition the rows', async () => {
    const all = await countWith(null);
    const isNull = await countWith({ children: [leaf('value', 'IS_NULL')] });
    const notNull = await countWith({ children: [leaf('value', 'IS_NOT_NULL')] });
    expect(isNull.errors).toBeUndefined();
    expect(isNull.total! + notNull.total!).toBe(all.total);
  });

  test.each([
    ['unknown column', { children: [leaf('no_such_column', 'EQ', 1)] }, 'no_such_column'],
    [
      'operation incompatible with the type',
      { children: [leaf('country', 'CONTAINS', 'x')] },
      'Allowed operations',
    ],
    ['incomplete BETWEEN', { children: [leaf('value', 'BETWEEN', { min: 1 })] }, '{min, max}'],
    ['empty IN list', { children: [leaf('country', 'IN', [])] }, 'non-empty array'],
    ['empty root group', { children: [] }, 'empty group'],
    [
      'criterion + children on one node',
      {
        criterion: { variable: 'country', operation: 'EQ', value: 1 },
        children: [leaf('kind', 'EQ', 1)],
      },
      'exactly one',
    ],
    ['invalid date', { children: [leaf('date', 'AFTER', '31/12/2024')] }, 'ISO 8601'],
    [
      'date out of TIMESTAMP_NS range',
      { children: [leaf('date', 'BEFORE', '2999-12-31')] },
      'out of range',
    ],
    [
      'injection in variable',
      { children: [leaf('country = 1; DROP TABLE fact_table; --', 'EQ', 1)] },
      'Invalid filter variable',
    ],
  ])('rejects %s with BAD_USER_INPUT', async (_label, tree, fragment) => {
    const { errors } = await countWith(tree);
    expect(errors).toBeDefined();
    expect(errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(errors![0].message).toContain(fragment);
  });

  test('applies sorting — values in descending order', async () => {
    const query = `
      query {
        getFactTable(
          sort: [{ field: "value", order: DESC }, { field: "date", order: ASC }]
          limit: 15
          offset: 0
        ) {
          data { measures { name value } }
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de l'ordre décroissant des valeurs (mesure "value")
    const values = (
      result.data!.getFactTable as {
        data: Array<{ measures: Array<{ name: string; value: number }> }>;
      }
    ).data.map((d) => d.measures.find((m) => m.name === 'value')!.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    }
  });

  test('selects specific fields', async () => {
    const query = `
      query {
        getFactTable(fields: ["country", "indicator", "value", "date"], limit: 5, offset: 0) {
          data { measures { name value } }
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect((result.data!.getFactTable as { data: unknown[] }).data.length).toBeLessThanOrEqual(5);
  });

  test('returns dimension details with labels', async () => {
    const query = `
      query {
        getFactTable(limit: 5, offset: 0) {
          data {
            measures { name value }
            dimensionDetails { name value label }
          }
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de la présence du détail de dimension "country" avec son label
    const firstRow = (
      result.data!.getFactTable as {
        data: Array<{ dimensionDetails: Array<{ name: string; label: unknown }> }>;
      }
    ).data[0];
    const details = firstRow.dimensionDetails;
    expect(Array.isArray(details)).toBe(true);
    const countryDetail = details.find((d) => d.name === 'country');
    if (countryDetail) {
      expect(countryDetail.label).toBeDefined();
    }
  });

  test('handles multiple pages — currentPage increments correctly', async () => {
    const query = `
      query {
        page1: getFactTable(limit: 10, offset: 0) { data { measures { name value } } total currentPage hasNextPage }
        page2: getFactTable(limit: 10, offset: 10) { data { measures { name value } } currentPage hasNextPage }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de l'incrémentation correcte du numéro de page
    const page1 = result.data!.page1 as { currentPage: number; total: unknown };
    const page2 = result.data!.page2 as { currentPage: number };
    expect(page1.currentPage).toBe(1);
    expect(page2.currentPage).toBe(2);
    expect(page1.total).toBeDefined();
  });

  test('handles mixed operations in a single filter tree', async () => {
    const { total, errors } = await countWith({
      children: [
        leaf('country', 'IN', [1, 2, 3]),
        leaf('kind', 'EQ', 1, 'AND'),
        leaf('indicator', 'NOT_IN', [5, 6], 'AND'),
      ],
    });

    expect(errors).toBeUndefined();
    expect(typeof total).toBe('number');
  });

  test('rejects limit > 1000', async () => {
    const query = `query { getFactTable(limit: 1001, offset: 0) { data { measures { name value } } } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain('Limit cannot exceed 1000');
  });

  test('rejects offset > 10000', async () => {
    const query = `query { getFactTable(limit: 10, offset: 10001) { data { measures { name value } } } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain('Offset cannot exceed 10000');
  });

  test('accepts explicit empty database parameter (falls back to default)', async () => {
    const noParam = `query { getFactTable(limit: 5, offset: 0) { data { measures { name value } } total } }`;
    const withEmpty = `query { getFactTable(limit: 5, offset: 0, catalog: "") { data { measures { name value } } total } }`;

    const r1 = await execute(server, { query: noParam });
    const r2 = await execute(server, { query: withEmpty });

    expect(r1.errors).toBeUndefined();
    expect(r2.errors).toBeUndefined();
    expect((r2.data!.getFactTable as { total: number }).total).toBe(
      (r1.data!.getFactTable as { total: number }).total,
    );
  });

  test('rejects an invalid database', async () => {
    const query = `query { getFactTable(limit: 5, offset: 0, catalog: "nonexistent_db_xyz") { data { measures { name value } } } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });

  test('handles query variables', async () => {
    const query = `
      query TestVars($country: JSON!, $limit: Int!, $offset: Int!) {
        getFactTable(
          structuredFilters: { children: [{ criterion: { variable: "country", operation: EQ, value: $country } }] }
          limit: $limit
          offset: $offset
        ) { data { measures { name value } } total }
      }
    `;
    const result = await execute(server, {
      query,
      variables: { country: 1, limit: 10, offset: 0 },
    });

    expect(result.errors).toBeUndefined();
    expect((result.data!.getFactTable as { data: unknown[] }).data.length).toBeLessThanOrEqual(10);
  });

  test('handles large datasets (1000 records) in under 10s', async () => {
    const query = `query { getFactTable(limit: 1000, offset: 0) { data { measures { name value } } total } }`;
    // Mesure du temps d'exécution pour la vérification de performance
    const t = Date.now();
    const result = await execute(server, { query });
    expect(result.errors).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(10000);
  });

  test('binds injection attempts in values as plain parameters', async () => {
    // La valeur est liée comme paramètre : elle est typée (numérique) et rejetée
    const numeric = await countWith({ children: [leaf('country', 'EQ', '1 OR 1=1')] });
    expect(numeric.errors![0].extensions?.code).toBe('BAD_USER_INPUT');

    // Aucune ligne supprimée : le comptage reste identique après la tentative
    const before = await countWith(null);
    await countWith({ children: [leaf('country', 'IN', ['1; DROP TABLE fact_table; --'])] });
    const after = await countWith(null);
    expect(after.total).toBe(before.total);
  });

  test('rejects malformed fields and sort fields with BAD_USER_INPUT', async () => {
    const badFields = await execute(server, {
      query: `query { getFactTable(fields: ["country", "a; DROP TABLE fact_table"], limit: 5, offset: 0) { total } }`,
    });
    expect(badFields.errors).toBeDefined();
    expect(badFields.errors![0].extensions?.code).toBe('BAD_USER_INPUT');

    const badSort = await execute(server, {
      query: `query { getFactTable(sort: [{ field: "value; DROP TABLE x", order: ASC }], limit: 5, offset: 0) { total } }`,
    });
    expect(badSort.errors).toBeDefined();
    expect(badSort.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  });
});

// ─── Tests getFactTableWithMetadata ──────────────────────────────────────────

describe('getFactTableWithMetadata', () => {
  test('returns columns, data, and metadata (OBJECTS format by default)', async () => {
    const query = `
      query {
        getFactTableWithMetadata(limit: 50, offset: 0) {
          columns
          data
          metadata { count extents total hasNextPage currentPage totalPages }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const r = result.data!.getFactTableWithMetadata as {
      columns: unknown[];
      data: unknown;
      metadata: { count: number; extents: unknown };
    };
    expect(Array.isArray(r.columns)).toBe(true);
    expect(r.data).toBeDefined();
    expect(r.metadata.count).toBeGreaterThan(0);
    expect(r.metadata.extents).toBeDefined();
  });

  test('OBJECTS format — data items are objects (not arrays)', async () => {
    const query = `
      query {
        getFactTableWithMetadata(limit: 5, offset: 0, format: OBJECTS) {
          columns
          data
          metadata { count total }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification que chaque ligne de données est un objet et non un tableau
    const rows = (result.data!.getFactTableWithMetadata as { data: unknown[] }).data;
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      expect(typeof rows[0]).toBe('object');
      expect(Array.isArray(rows[0])).toBe(false);
    }
  });

  test('ARRAYS format — data items are arrays matching columns length', async () => {
    const query = `
      query {
        getFactTableWithMetadata(limit: 5, offset: 0, format: ARRAYS) {
          columns
          data
          metadata { count total }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const r = result.data!.getFactTableWithMetadata as {
      columns: unknown[];
      data: Array<unknown[]>;
    };
    expect(Array.isArray(r.columns)).toBe(true);

    // Vérification que chaque ligne est un tableau de longueur égale au nombre de colonnes
    if (r.data.length > 0) {
      expect(Array.isArray(r.data[0])).toBe(true);
      expect(r.data[0].length).toBe(r.columns.length);
    }
  });

  test('ARRAYS format with filters and sort', async () => {
    const query = `
      query {
        getFactTableWithMetadata(
          structuredFilters: { children: [{ criterion: { variable: "country", operation: IN, value: [1, 2, 3] } }] }
          sort: [{ field: "value", order: DESC }]
          limit: 10
          offset: 0
          format: ARRAYS
        ) {
          columns
          data
          metadata { count extents total }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const r = result.data!.getFactTableWithMetadata as {
      data: Array<unknown[]>;
      metadata: { count: number };
    };
    expect(r.metadata.count).toBeGreaterThan(0);
    if (r.data.length > 0) {
      expect(Array.isArray(r.data[0])).toBe(true);
    }
  });

  test('applies filters and computes metadata correctly', async () => {
    const query = `
      query {
        getFactTableWithMetadata(
          structuredFilters: { children: [{ criterion: { variable: "country", operation: IN, value: [1, 2, 3] } }] }
          limit: 100
          offset: 0
        ) { columns data metadata { count extents total } }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const meta = (
      result.data!.getFactTableWithMetadata as {
        metadata: { count: number; extents: unknown };
      }
    ).metadata;
    expect(meta.count).toBeGreaterThan(0);
    expect(meta.extents).toBeDefined();
  });
});

// ─── Tests de gestion des erreurs ─────────────────────────────────────────────

describe('error handling', () => {
  test('rejects invalid sort order', async () => {
    const query = `
      query {
        getFactTable(sort: [{ field: "value", order: INVALID }], limit: 10, offset: 0) {
          data { measures { name value } }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain('SortOrder');
  });

  test('rejects an unknown filter operation at validation time', async () => {
    const query = `
      query {
        getFactTable(
          structuredFilters: { children: [{ criterion: { variable: "country", operation: INVALID_OP, value: 1 } }] }
          limit: 10
          offset: 0
        ) { data { measures { name value } } }
      }
    `;
    const result = await execute(server, { query });
    // L'enum FilterOperation rejette l'opération avant toute exécution
    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain('FilterOperation');
  });
});

// ─── Tests de requête combinée complexe ───────────────────────────────────────

describe('complex combined query', () => {
  test('metadata + dimensions + facts + aggregations + options in one request', async () => {
    const query = `
      query {
        countryMeta: getMetaData(name: "country") { name label is_categorical }
        countries: getDimensionTable(name: "country") { value label }
        facts: getFactTable(
          structuredFilters: { children: [{ criterion: { variable: "country", operation: EQ, value: 1 } }] }
          sort: [{ field: "value", order: DESC }]
          limit: 5
          offset: 0
        ) { data { measures { name value } dimensionDetails { name value label } } total }
        aggregated: getAggregatedFacts(
          measure: "value"
          groupBy: "indicator"
          aggregation: AVG
          structuredFilters: { children: [{ criterion: { variable: "country", operation: EQ, value: 1 } }] }
        ) { key keyLabel aggregatedValue }
        options: getSelectOptions(fieldName: "indicator") { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de la présence et cohérence de tous les résultats dans la réponse combinée
    expect((result.data!.countryMeta as { name: string }).name).toBe('country');
    expect(Array.isArray(result.data!.countries)).toBe(true);
    expect((result.data!.facts as { data: unknown }).data).toBeDefined();
    expect(Array.isArray(result.data!.aggregated)).toBe(true);
    expect(Array.isArray(result.data!.options)).toBe(true);
  });
});
