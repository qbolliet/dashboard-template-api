/**
 * Integration tests for the column statistics (FieldStats).
 *
 * Covers getFieldStats and the lazy Metadata.stats field on the real test
 * catalog: numeric, date and timestamp columns, a column with NULLs, a BIGINT
 * beyond 2^53 (exact decimal string), text and boolean columns (lexical
 * min/max), the filtered variant, an unknown column, laziness on every
 * resolver producing a Metadata, and the per-request deduplication of queries.
 * Expected values come from independent SQL queries on the same catalog.
 */

import { jest } from '@jest/globals';
import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';
import { databaseManager } from '../../../../src/db/index.js';
import { redis } from '../../../../src/cache/index.js';
import { createLoaders } from '../../../../src/loaders/index.js';
import { FieldStatsLoader } from '../../../../src/loaders/field-stats.js';
import { catalogResolvers } from '../../../../src/schema/resolvers/catalog.js';
import { fieldStatsResolvers } from '../../../../src/schema/resolvers/field-stats.js';
import type { DuckDBConnection } from '../../../../src/loaders/base-loader.js';
import type { GraphQLContext } from '../../../../src/schema/resolvers/types.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
  await clearStatsCache();
}, 60000);

// ─── Interfaces et fonctions utilitaires ──────────────────────────────────────

/** Statistiques d'une colonne, telles que renvoyées par l'API. */
interface Stats {
  min: unknown;
  max: unknown;
  distinctCount: number;
  nullCount: number;
}

/** 2^53 : premier entier que la sérialisation JSON en nombre ne représente plus exactement. */
const TWO_POW_53 = 2n ** 53n;

// Fragment de sélection commun à toutes les requêtes du fichier
const STATS = 'stats { min max distinctCount nullCount }';

/**
 * Runs a read-only SQL query on the default catalog, as an independent
 * reference for the statistics computed by the API.
 *
 * @param sql - Query using the `{fact}` placeholder for the qualified table.
 * @param schema - DuckLake schema of the fact table.
 * @returns The rows, converted by the pool like any API read.
 */
// Requête de référence, indépendante du loader testé
async function reference(sql: string, schema = 'main'): Promise<Record<string, unknown>[]> {
  const catalog = databaseManager.getDefaultCatalog();
  const pool = databaseManager.getPool(null) as unknown as {
    acquire: () => Promise<DuckDBConnection>;
    release: (connection: DuckDBConnection) => void;
  };
  const connection = await pool.acquire();
  try {
    return await connection.all(sql.replace('{fact}', `"${catalog}".${schema}.fact_table`));
  } finally {
    pool.release(connection);
  }
}

/**
 * Empties the Redis entries of the column statistics.
 *
 * The test data is regenerated at every run while Redis outlives it: a warm
 * entry of a previous run would answer with stale bounds and without reaching
 * the loader, which breaks both the comparison with the table and the counts of
 * SQL queries. ioredis prepends its `keyPrefix` to the keys of a command but not
 * to the MATCH pattern of SCAN, nor does it strip it from the keys SCAN returns:
 * both are handled here. With Redis down the loader runs on every call, so the
 * tests hold as well.
 */
// Vidage du cache des statistiques, sensible au préfixe de clés d'ioredis
async function clearStatsCache(): Promise<void> {
  try {
    const prefix =
      (redis as unknown as { options: { keyPrefix?: string } }).options.keyPrefix ?? '';
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}field-stats:*`,
        'COUNT',
        100,
      );
      if (keys.length > 0) await redis.del(...keys.map((key) => key.slice(prefix.length)));
      cursor = next;
    } while (cursor !== '0');
  } catch {
    // Redis indisponible : le loader s'exécute à chaque appel
  }
}

/**
 * Runs getFieldStats and returns its statistics, failing on any error.
 *
 * @param args - GraphQL argument list, without the surrounding parentheses.
 * @returns The statistics of the column.
 */
// Exécution de getFieldStats, échec sur toute erreur GraphQL
async function fieldStats(args: string): Promise<Stats> {
  const result = await execute(server, {
    query: `query { getFieldStats(${args}) { min max distinctCount nullCount } }`,
  });
  expect(result.errors).toBeUndefined();
  return result.data!.getFieldStats as Stats;
}

// Filtre « une seule feuille » pour une égalité
const eq = (variable: string, value: string): string =>
  `structuredFilters: { children: [{ criterion: { variable: "${variable}", operation: EQ, value: "${value}" } }] }`;

// ─── getFieldStats ────────────────────────────────────────────────────────────

describe('getFieldStats', () => {
  test('numeric column: min, max, distinctCount and nullCount match the table', async () => {
    const stats = await fieldStats('fieldName: "value"');
    const [expected] = await reference(
      `SELECT MIN(value) AS min, MAX(value) AS max, COUNT(DISTINCT value) AS distinct_count,
              COUNT(*) - COUNT(value) AS null_count FROM {fact}`,
    );

    expect(typeof stats.min).toBe('number');
    expect(typeof stats.max).toBe('number');
    expect(stats).toEqual({
      min: expected.min,
      max: expected.max,
      distinctCount: expected.distinct_count,
      nullCount: expected.null_count,
    });
    expect(stats.min as number).toBeLessThan(stats.max as number);
  });

  test('integer column: bounds are JSON numbers', async () => {
    const stats = await fieldStats('fieldName: "horizon"');

    expect(typeof stats.min).toBe('number');
    expect(typeof stats.max).toBe('number');
    expect(stats.min as number).toBeLessThanOrEqual(stats.max as number);
  });

  test('date column: bounds are ISO 8601 dates', async () => {
    const stats = await fieldStats('fieldName: "date"');
    const [expected] = await reference(
      `SELECT CAST(MIN(date) AS VARCHAR) AS min, CAST(MAX(date) AS VARCHAR) AS max FROM {fact}`,
    );

    expect(stats.min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stats.max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stats.min).toBe(expected.min);
    expect(stats.max).toBe(expected.max);
    expect((stats.min as string) < (stats.max as string)).toBe(true);
  });

  test('timestamp column: bounds are ISO 8601 with a T separator', async () => {
    const stats = await fieldStats('fieldName: "ingested_at"');

    expect(stats.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(stats.max).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('column with NULLs: nullCount counts them and distinctCount ignores them', async () => {
    const stats = await fieldStats('fieldName: "notes"');
    const [expected] = await reference(
      `SELECT COUNT(*) - COUNT(notes) AS null_count, COUNT(DISTINCT notes) AS distinct_count
       FROM {fact}`,
    );

    expect(stats.nullCount).toBeGreaterThan(0);
    expect(stats.nullCount).toBe(expected.null_count);
    expect(stats.distinctCount).toBe(expected.distinct_count);
  });

  test('BIGINT beyond 2^53: the bound is the exact decimal string', async () => {
    const stats = await fieldStats('fieldName: "headcount"');
    const [expected] = await reference(
      `SELECT CAST(MIN(headcount) AS VARCHAR) AS min, CAST(MAX(headcount) AS VARCHAR) AS max
       FROM {fact}`,
    );

    // Le min tient dans un nombre JSON, le max le dépasse : chaîne exacte
    expect(typeof stats.min).toBe('number');
    expect(String(stats.min)).toBe(expected.min);
    expect(typeof stats.max).toBe('string');
    expect(stats.max).toBe(expected.max);
    expect(BigInt(stats.max as string) > TWO_POW_53).toBe(true);
  });

  test('UBIGINT column of another schema is served through the schema argument', async () => {
    const stats = await fieldStats('fieldName: "population", schema: "geography"');
    const [expected] = await reference(
      `SELECT MIN(population) AS min, MAX(population) AS max FROM {fact}`,
      'geography',
    );

    expect(stats.min).toBe(expected.min);
    expect(stats.max).toBe(expected.max);
  });

  test('text column: min and max are computed in lexical order', async () => {
    const stats = await fieldStats('fieldName: "country"');
    const [expected] = await reference(
      `SELECT MIN(country) AS min, MAX(country) AS max FROM {fact}`,
    );

    expect(stats.min).toBe(expected.min);
    expect(stats.max).toBe(expected.max);
    expect((stats.min as string) < (stats.max as string)).toBe(true);
  });

  test('boolean column: min and max are booleans', async () => {
    const stats = await fieldStats('fieldName: "is_provisional"');

    expect(stats).toMatchObject({ min: false, max: true });
  });

  test('filtered variant: min and max change with the filter', async () => {
    const whole = await fieldStats('fieldName: "value"');
    const filtered = await fieldStats(`fieldName: "value", ${eq('country', 'France')}`);
    const [expected] = await reference(
      `SELECT MIN(value) AS min, MAX(value) AS max, COUNT(DISTINCT value) AS distinct_count
       FROM {fact} WHERE country = 'France'`,
    );

    expect(filtered.min).toBe(expected.min);
    expect(filtered.max).toBe(expected.max);
    expect(filtered.distinctCount).toBe(expected.distinct_count);
    // La variante filtrée resserre les bornes de la variante complète
    expect(filtered.min as number).toBeGreaterThan(whole.min as number);
    expect(filtered.max as number).toBeLessThan(whole.max as number);
    expect(filtered.distinctCount).toBeLessThan(whole.distinctCount);
  });

  test('filter matching no row: null bounds and zero counts', async () => {
    const stats = await fieldStats(`fieldName: "value", ${eq('country', 'Atlantis')}`);

    expect(stats).toEqual({ min: null, max: null, distinctCount: 0, nullCount: 0 });
  });

  test('the filter may bear on the column itself', async () => {
    const stats = await fieldStats(
      `fieldName: "horizon", structuredFilters: { children: [{ criterion: { variable: "horizon", operation: GTE, value: 1 } }] }`,
    );

    expect(stats.min as number).toBeGreaterThanOrEqual(1);
  });

  test('unknown column: GraphQLError BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query { getFieldStats(fieldName: "no_such_column") { min } }`,
    });

    expect(result.data).toBeNull();
    expect(result.errors![0].message).toMatch(/no_such_column/);
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  test('unsafe column name: rejected before any SQL', async () => {
    const spy = jest.spyOn(FieldStatsLoader.prototype, 'loadStats');
    const result = await execute(server, {
      query: `query { getFieldStats(fieldName: "value; DROP TABLE fact_table") { min } }`,
    });

    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(spy).not.toHaveBeenCalled();
  });

  test('invalid filter tree: GraphQLError BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query { getFieldStats(fieldName: "value", ${eq('no_such_column', 'x')}) { min } }`,
    });

    expect(result.data).toBeNull();
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  test('unknown schema: error naming the allowed schemas', async () => {
    const result = await execute(server, {
      query: `query { getFieldStats(fieldName: "value", schema: "nope") { min } }`,
    });

    expect(result.errors![0].message).toMatch(/nope/);
  });
});

// ─── Metadata.stats (lazy) ────────────────────────────────────────────────────

describe('Metadata.stats', () => {
  test('getCatalogSchema: stats are resolved lazily, only on the selected columns', async () => {
    await clearStatsCache();
    const spy = jest.spyOn(FieldStatsLoader.prototype, 'loadStats');

    const withoutStats = await execute(server, {
      query: `query { getCatalogSchema { name label } }`,
    });
    expect(withoutStats.errors).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();

    const withStats = await execute(server, {
      query: `query { getCatalogSchema { name ${STATS} } }`,
    });
    expect(withStats.errors).toBeUndefined();
    const columns = withStats.data!.getCatalogSchema as Array<{ name: string; stats: Stats }>;
    // Une requête SQL par colonne : N colonnes, N requêtes
    expect(spy).toHaveBeenCalledTimes(columns.length);

    const value = columns.find((c) => c.name === 'value')!;
    expect(value.stats).toEqual(await fieldStats('fieldName: "value"'));
    const date = columns.find((c) => c.name === 'date')!;
    expect(date.stats.min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('getCatalogSchema on another schema queries that schema', async () => {
    const result = await execute(server, {
      query: `query { getCatalogSchema(schema: "geography") { name ${STATS} } }`,
    });
    expect(result.errors).toBeUndefined();
    const columns = result.data!.getCatalogSchema as Array<{ name: string; stats: Stats }>;
    const [expected] = await reference(
      `SELECT MIN(population) AS min, MAX(population) AS max FROM {fact}`,
      'geography',
    );

    const population = columns.find((c) => c.name === 'population')!;
    expect(population.stats.min).toBe(expected.min);
    expect(population.stats.max).toBe(expected.max);
  });

  test('getMetaData carries its stats', async () => {
    const result = await execute(server, {
      query: `query { getMetaData(name: "headcount") { name ${STATS} } }`,
    });

    expect(result.errors).toBeUndefined();
    const meta = result.data!.getMetaData as { name: string; stats: Stats };
    expect(meta.stats).toEqual(await fieldStats('fieldName: "headcount"'));
  });

  test('getMetaData on an unknown field stays null', async () => {
    const result = await execute(server, {
      query: `query { getMetaData(name: "no_such_column") { name ${STATS} } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getMetaData).toBeNull();
  });

  test('catalog schemas: fields carry the stats of their own catalog and schema', async () => {
    // Appel direct : getCatalogs listerait aussi les schémas de test refusés par la garde de version
    const catalog = databaseManager.getDefaultCatalog();
    const context = {
      loaders: createLoaders(catalog),
      requestCatalog: catalog,
      requestSchema: null,
      getLoadersForCatalog: (target: string | null, schema: string | null = null) =>
        target === catalog && schema === null ? null : createLoaders(target ?? catalog, schema),
    } as unknown as GraphQLContext;

    const fields = await catalogResolvers.CatalogSchemaInfo.fields(
      { catalogId: catalog, name: 'geography' },
      {},
      context,
    );
    const population = fields.find((f) => f.name === 'population')!;
    const stats = await fieldStatsResolvers.Metadata.stats(population, {}, context);
    const [expected] = await reference(
      `SELECT MIN(population) AS min, MAX(population) AS max FROM {fact}`,
      'geography',
    );

    expect(stats.min).toBe(expected.min);
    expect(stats.max).toBe(expected.max);
  });

  test('a Metadata without catalog/schema fails explicitly instead of guessing', async () => {
    const catalog = databaseManager.getDefaultCatalog();
    const context = { loaders: createLoaders(catalog) } as unknown as GraphQLContext;
    const orphan = { name: 'value' } as Parameters<typeof fieldStatsResolvers.Metadata.stats>[0];

    await expect(fieldStatsResolvers.Metadata.stats(orphan, {}, context)).rejects.toThrow(
      /no catalog\/schema/,
    );
  });

  test('getFactTableWithMetadata: fields of the returned columns carry their stats', async () => {
    const result = await execute(server, {
      query: `query {
        getFactTableWithMetadata(fields: ["value", "date"], limit: 3) {
          columns
          fields { name ${STATS} }
        }
      }`,
    });
    expect(result.errors).toBeUndefined();
    const page = result.data!.getFactTableWithMetadata as {
      columns: string[];
      fields: Array<{ name: string; stats: Stats }>;
    };

    expect(page.fields.map((f) => f.name)).toEqual(['value', 'date']);
    // Bornes globales de la colonne, pas celles des trois lignes de la page
    expect(page.fields[0].stats).toEqual(await fieldStats('fieldName: "value"'));
    expect(page.fields[1].stats).toEqual(await fieldStats('fieldName: "date"'));
  });

  test('getAggregatedFactsWithMetadata: group-by and measure infos carry their stats', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFactsWithMetadata(groupBy: "country", measure: "value", aggregation: SUM) {
          metadata {
            groupByFieldInfo { name ${STATS} }
            measureFieldInfo { name ${STATS} }
          }
        }
      }`,
    });
    expect(result.errors).toBeUndefined();
    const metadata = (
      result.data!.getAggregatedFactsWithMetadata as {
        metadata: {
          groupByFieldInfo: { name: string; stats: Stats };
          measureFieldInfo: { name: string; stats: Stats };
        };
      }
    ).metadata;

    expect(metadata.groupByFieldInfo.stats).toEqual(await fieldStats('fieldName: "country"'));
    expect(metadata.measureFieldInfo.stats).toEqual(await fieldStats('fieldName: "value"'));
  });

  test('one request asking the same column twice runs one SQL query', async () => {
    await clearStatsCache();
    const spy = jest.spyOn(FieldStatsLoader.prototype, 'loadStats');

    const result = await execute(server, {
      query: `query {
        first: getMetaData(name: "value") { stats { min } }
        second: getMetaData(name: "value") { stats { max } }
        third: getFieldStats(fieldName: "value") { distinctCount }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a filtered and an unfiltered variant of a column are two distinct queries', async () => {
    await clearStatsCache();
    const spy = jest.spyOn(FieldStatsLoader.prototype, 'loadStats');

    const result = await execute(server, {
      query: `query {
        whole: getFieldStats(fieldName: "value") { min }
        filtered: getFieldStats(fieldName: "value", ${eq('country', 'France')}) { min }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
