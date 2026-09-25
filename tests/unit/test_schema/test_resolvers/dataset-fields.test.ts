/**
 * Integration tests for the column metadata and the value serialization of
 * the chart/table queries.
 *
 * Covers DatasetWithMetadata.fields (aligned on columns, projection through
 * `fields`, OBJECTS and ARRAYS, explicit failure on a column without metadata),
 * AggregatedFactsMetadata.measureFieldInfo, the value types guaranteed on every
 * JSON path (safe integer → number, beyond 2^53 → decimal string, DATE and
 * TIMESTAMP → ISO 8601, BOOLEAN, NULL) and the page extents of numeric and
 * date/timestamp columns.
 */

import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { ensureSetup, getServer, execute } from './helpers.js';
import { factResolvers } from '../../../../src/schema/resolvers/fact.js';
import type { DatasetSource } from '../../../../src/schema/resolvers/fact.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

// ─── Interfaces et fonctions utilitaires ──────────────────────────────────────

/** Métadonnées d'une colonne, telles que demandées par les requêtes de ce fichier. */
interface FieldInfo {
  name: string;
  label: string;
  sqlType: string;
  unit: string | null;
  displayFormat: string | null;
  labelFields: string[];
}

/** Ligne de getFactTable : coordonnées et mesures nommées. */
interface FactRow {
  keys: Array<{ name: string; value: unknown }>;
  measures: Array<{ name: string; value: unknown }>;
}

/** Page retournée par getFactTableWithMetadata pour les requêtes de ce fichier. */
interface Page {
  columns: string[];
  fields: FieldInfo[];
  data: Array<Record<string, unknown> | unknown[]>;
  metadata: { count: number; extents: Record<string, [unknown, unknown]> };
}

/**
 * Runs getFactTableWithMetadata and returns the page, failing on any error.
 *
 * @param args - GraphQL argument list, without the surrounding parentheses.
 * @returns The page with columns, fields, data and metadata.
 */
// Exécution d'une page enrichie, échec sur toute erreur GraphQL
async function loadPage(args: string): Promise<Page> {
  const result = await execute(server, {
    query: `
      query {
        getFactTableWithMetadata(${args}) {
          columns
          fields { name label sqlType unit displayFormat labelFields }
          data
          metadata { count extents }
        }
      }
    `,
  });
  expect(result.errors).toBeUndefined();
  return result.data!.getFactTableWithMetadata as Page;
}

// Filtre de type « une seule feuille » pour une égalité
const eq = (variable: string, value: string): string =>
  `structuredFilters: { children: [{ criterion: { variable: "${variable}", operation: EQ, value: "${value}" } }] }`;

// ─── DatasetWithMetadata.fields ───────────────────────────────────────────────

describe('DatasetWithMetadata.fields', () => {
  test('is aligned on columns: same names, same order', async () => {
    const page = await loadPage('limit: 5');

    expect(page.fields).toHaveLength(page.columns.length);
    expect(page.fields.map((f) => f.name)).toEqual(page.columns);
  });

  test('follows the projection requested through the fields argument', async () => {
    const page = await loadPage('fields: ["value", "country", "date"], limit: 5');

    expect(page.columns).toEqual(['value', 'country', 'date']);
    expect(page.fields.map((f) => f.name)).toEqual(['value', 'country', 'date']);
  });

  test('exposes unit, display format and SQL type for the axes', async () => {
    const page = await loadPage('fields: ["value", "date", "headcount"], limit: 1');
    const byName = Object.fromEntries(page.fields.map((f) => [f.name, f]));

    expect(byName.value).toMatchObject({
      label: 'Measurement Value',
      sqlType: 'DOUBLE',
      unit: '€',
      displayFormat: ',.2f',
    });
    expect(byName.date).toMatchObject({ sqlType: 'DATE', unit: null, displayFormat: null });
    expect(byName.headcount).toMatchObject({ sqlType: 'BIGINT', unit: 'personnes' });
  });

  test('is also aligned in ARRAYS format, whose rows follow the same order', async () => {
    const page = await loadPage('fields: ["kind", "value", "date"], limit: 3, format: ARRAYS');

    expect(page.fields.map((f) => f.name)).toEqual(page.columns);
    for (const row of page.data) {
      expect(Array.isArray(row)).toBe(true);
      expect((row as unknown[]).length).toBe(page.fields.length);
      expect(typeof (row as unknown[])[1]).toBe('number'); // colonne « value »
    }
  });

  test('carries labelFields without any additional query', async () => {
    const page = await loadPage('schema: "trade", fields: ["nc8", "nc8_libelle_fr"], limit: 3');
    const byName = Object.fromEntries(page.fields.map((f) => [f.name, f]));

    expect(byName.nc8.labelFields).toEqual(['nc8_libelle_en', 'nc8_libelle_fr']);
    expect(byName.nc8_libelle_fr.labelFields).toEqual([]);
  });

  test('is resolved on the target catalog and schema', async () => {
    const page = await loadPage('schema: "geography", fields: ["budget", "region"], limit: 3');

    expect(page.fields.map((f) => f.name)).toEqual(['budget', 'region']);
    expect(page.fields[0]).toMatchObject({ sqlType: 'BIGINT', unit: '€' });
  });

  test('fails explicitly when a returned column has no metadata row', async () => {
    const parent: DatasetSource = {
      columns: ['country', 'orphan_column'],
      metadataLoader: {
        load: async (name: string) => (name === 'country' ? { name } : null),
      } as unknown as DatasetSource['metadataLoader'],
    };

    await expect(factResolvers.DatasetWithMetadata.fields(parent)).rejects.toThrow(GraphQLError);
    await expect(factResolvers.DatasetWithMetadata.fields(parent)).rejects.toThrow(/orphan_column/);
  });
});

// ─── AggregatedFactsMetadata.measureFieldInfo ─────────────────────────────────

describe('AggregatedFactsMetadata.measureFieldInfo', () => {
  /**
   * Runs getAggregatedFactsWithMetadata and returns its metadata field infos.
   *
   * @param groupBy - Group-by column.
   * @param measure - Measure column.
   * @returns The groupByFieldInfo and measureFieldInfo of the response.
   */
  // Métadonnées de la clé de groupe et de la mesure d'une agrégation
  async function aggregate(groupBy: string, measure: string) {
    const result = await execute(server, {
      query: `
        query {
          getAggregatedFactsWithMetadata(groupBy: "${groupBy}", measure: "${measure}", limit: 5) {
            metadata {
              groupByFieldInfo { name unit }
              measureFieldInfo { name label unit displayFormat defaultAggregation }
            }
          }
        }
      `,
    });
    expect(result.errors).toBeUndefined();
    return (
      result.data!.getAggregatedFactsWithMetadata as {
        metadata: {
          groupByFieldInfo: { name: string; unit: string | null };
          measureFieldInfo: {
            name: string;
            label: string;
            unit: string | null;
            displayFormat: string | null;
            defaultAggregation: string | null;
          };
        };
      }
    ).metadata;
  }

  test('describes the aggregated measure next to the group-by column', async () => {
    const metadata = await aggregate('country', 'value');

    expect(metadata.groupByFieldInfo.name).toBe('country');
    expect(metadata.measureFieldInfo).toEqual({
      name: 'value',
      label: 'Measurement Value',
      unit: '€',
      displayFormat: ',.2f',
      defaultAggregation: 'SUM',
    });
  });

  test('follows the measure asked for', async () => {
    const metadata = await aggregate('country', 'quality_score');

    expect(metadata.measureFieldInfo).toMatchObject({
      name: 'quality_score',
      unit: null,
      displayFormat: '.0%',
      defaultAggregation: 'AVG',
    });
  });
});

// ─── Sérialisation garantie des types ─────────────────────────────────────────

describe('value serialization on the JSON paths', () => {
  test('BIGINT beyond 2^53 is a decimal string, on OBJECTS and ARRAYS alike', async () => {
    const objects = await loadPage('schema: "geography", fields: ["budget"], limit: 3');
    const arrays = await loadPage(
      'schema: "geography", fields: ["budget"], limit: 3, format: ARRAYS',
    );

    for (const row of objects.data as Array<Record<string, unknown>>) {
      expect(typeof row.budget).toBe('string');
      expect(BigInt(row.budget as string)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    }
    for (const row of arrays.data as unknown[][]) {
      expect(typeof row[0]).toBe('string');
    }
  });

  test('ordinary BIGINT is a number', async () => {
    const page = await loadPage(`fields: ["headcount"], ${eq('kind', 'Forecast')}, limit: 5`);

    expect(page.data.length).toBeGreaterThan(0);
    for (const row of page.data as Array<Record<string, unknown>>) {
      expect(row.headcount).toBe(1234567);
    }
  });

  test('UBIGINT, UINTEGER, FLOAT and DOUBLE are numbers', async () => {
    const page = await loadPage(
      'schema: "geography", fields: ["population", "area_km2", "density"], limit: 3',
    );

    for (const row of page.data as Array<Record<string, unknown>>) {
      expect(typeof row.population).toBe('number');
      expect(typeof row.area_km2).toBe('number');
      expect(typeof row.density === 'number' || row.density === null).toBe(true);
    }
  });

  test('DATE is YYYY-MM-DD and zone-less TIMESTAMP is ISO 8601 with a T separator', async () => {
    const page = await loadPage('fields: ["date", "ingested_at"], limit: 3');

    for (const row of page.data as Array<Record<string, unknown>>) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.ingested_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/);
    }
  });

  test('BOOLEAN is a boolean', async () => {
    const page = await loadPage('fields: ["is_provisional"], limit: 5');

    for (const row of page.data as Array<Record<string, unknown>>) {
      expect(typeof row.is_provisional).toBe('boolean');
    }
  });

  test('NULL is null, never a string or a hole', async () => {
    const objects = await loadPage(
      'fields: ["notes", "quality_score"], structuredFilters: { children: [{ criterion: { variable: "notes", operation: IS_NULL } }] }, limit: 5',
    );
    const arrays = await loadPage(
      'fields: ["notes", "quality_score"], structuredFilters: { children: [{ criterion: { variable: "notes", operation: IS_NULL } }] }, limit: 5, format: ARRAYS',
    );

    expect(objects.data.length).toBeGreaterThan(0);
    for (const row of objects.data as Array<Record<string, unknown>>) {
      expect(row.notes).toBeNull();
    }
    for (const row of arrays.data as unknown[][]) {
      expect(row[0]).toBeNull();
    }
  });

  test('getFactTable values follow the same rules', async () => {
    const result = await execute(server, {
      query: `
        query {
          getFactTable(schema: "geography", fields: ["budget", "population", "date"], limit: 3) {
            data { keys { name value } measures { name value } }
          }
        }
      `,
    });
    expect(result.errors).toBeUndefined();
    const rows = (result.data!.getFactTable as { data: FactRow[] }).data;

    const value = (row: FactRow, name: string) =>
      [...row.keys, ...row.measures].find((e) => e.name === name)?.value;
    for (const row of rows) {
      expect(typeof value(row, 'budget')).toBe('string');
      expect(typeof value(row, 'population')).toBe('number');
      expect(value(row, 'date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('aggregate keys and counts keep their shape', async () => {
    const result = await execute(server, {
      query: `
        query {
          getAggregatedFacts(groupBy: "country", measure: "value", limit: 5) { key count aggregatedValue }
        }
      `,
    });
    expect(result.errors).toBeUndefined();
    const rows = result.data!.getAggregatedFacts as Array<{
      key: string;
      count: number;
      aggregatedValue: number;
    }>;

    for (const row of rows) {
      expect(typeof row.key).toBe('string');
      expect(Number.isInteger(row.count)).toBe(true);
      expect(typeof row.aggregatedValue).toBe('number');
    }
  });
});

// ─── Extents de page ──────────────────────────────────────────────────────────

describe('DatasetMetadata.extents', () => {
  test('covers numeric columns, integers included', async () => {
    const page = await loadPage(
      `fields: ["value", "horizon", "headcount"], ${eq('kind', 'Forecast')}, limit: 20`,
    );
    const { extents } = page.metadata;

    expect(extents.value).toHaveLength(2);
    expect(typeof extents.value[0]).toBe('number');
    expect(extents.headcount).toEqual([1234567, 1234567]);
    expect(typeof extents.horizon[0]).toBe('number');
  });

  test('covers date columns with ISO string bounds, min before max', async () => {
    const page = await loadPage('fields: ["date"], limit: 50');
    const [min, max] = page.metadata.extents.date as [string, string];

    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(min <= max).toBe(true);
  });

  test('covers timestamp columns with ISO string bounds', async () => {
    const page = await loadPage('fields: ["ingested_at"], limit: 50');
    const [min, max] = page.metadata.extents.ingested_at as [string, string];

    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(min <= max).toBe(true);
  });

  test('bounds the page it is computed on, not the whole dataset', async () => {
    const sorted = 'sort: [{ field: "date", order: ASC }]';
    const first = await loadPage(`fields: ["date"], ${sorted}, limit: 5, offset: 0`);
    const last = await loadPage(`fields: ["date"], ${sorted}, limit: 5, offset: 1500`);

    const [firstMin] = first.metadata.extents.date as [string, string];
    const [lastMin] = last.metadata.extents.date as [string, string];
    expect(firstMin < lastMin).toBe(true);
  });

  test('has no entry for text and boolean columns nor for an all-NULL column', async () => {
    const page = await loadPage(
      `fields: ["country", "is_provisional", "notes"], structuredFilters: { children: [{ criterion: { variable: "notes", operation: IS_NULL } }] }, limit: 5`,
    );

    expect(page.metadata.extents).not.toHaveProperty('country');
    expect(page.metadata.extents).not.toHaveProperty('is_provisional');
    expect(page.metadata.extents).not.toHaveProperty('notes');
  });
});
