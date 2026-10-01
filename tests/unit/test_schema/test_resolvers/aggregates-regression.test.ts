/**
 * Non-regression of getAggregates against the former getAggregatedFacts.
 *
 * getAggregatedFacts (one measure, one aggregation, one groupBy) was removed
 * by getAggregates. Its SQL is kept here as the reference: run directly on the
 * test catalogs through the pool, it must give, group by group and in the
 * same order, the values, counts and group total that getAggregates returns
 * for one aggregate over one group column — on the main and geography
 * schemas, for every aggregation and every family of measure.
 */

import { ApolloServer } from '@apollo/server';
import { clearAggregatedCache, ensureSetup, getServer, execute } from './helpers.js';
import { databaseManager } from '../../../../src/db/index.js';
import { qualifiedTable, quoteIdent } from '../../../../src/utils/identifiers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
  // Entrées d'une exécution précédente, calculées sur d'autres données de test
  await clearAggregatedCache();
}, 60000);

// ─── SQL de référence (ancien loader getAggregatedFacts) ──────────────────────

/**
 * Runs a query on the test catalogs, outside the API.
 *
 * @param sql - Query to run.
 * @returns The rows, serialized by the single JSON converter.
 */
// Requête directe sur le pool partagé
async function query(sql: string): Promise<Record<string, unknown>[]> {
  const pool = databaseManager.getPool('default');
  const connection = await pool.acquire();
  try {
    return await connection.all(sql);
  } finally {
    pool.release(connection);
  }
}

/**
 * Former page query of getAggregatedFacts: key, aggregate and count of each
 * group, sorted by key (its default tie-break), every group.
 *
 * @param schema - Schema of the default catalog.
 * @param groupBy - Group column.
 * @param measure - Measure column.
 * @param aggregation - SQL aggregate function.
 * @returns The reference rows.
 */
// Requête de page de l'ancien loader
const referenceRows = (
  schema: string,
  groupBy: string,
  measure: string,
  aggregation: string,
): Promise<Record<string, unknown>[]> =>
  query(`
    SELECT ${quoteIdent(groupBy)} AS key,
           ${aggregation}(${quoteIdent(measure)}) AS aggregatedValue,
           COUNT(*) AS count
    FROM ${qualifiedTable('default', schema, 'fact_table')}
    GROUP BY ${quoteIdent(groupBy)}
    ORDER BY key ASC
  `);

/**
 * Former group count of getAggregatedFacts (getTotalGroups), NULL group included.
 *
 * @param schema - Schema of the default catalog.
 * @param groupBy - Group column.
 * @returns The number of groups.
 */
// Comptage des groupes de l'ancien loader
const referenceTotal = async (schema: string, groupBy: string): Promise<number> => {
  const rows = await query(`
    SELECT COUNT(*) AS totalGroups
    FROM (SELECT 1 FROM ${qualifiedTable('default', schema, 'fact_table')} GROUP BY ${quoteIdent(groupBy)})
  `);
  return Number(rows[0].totalGroups);
};

// ─── Cas ──────────────────────────────────────────────────────────────────────

// (schéma, groupBy, mesure, agrégation) : toutes les agrégations, toutes les familles
const CASES: [string, string, string, string][] = [
  ['main', 'country', 'value', 'SUM'],
  ['main', 'country', 'value', 'AVG'],
  ['main', 'country', 'value', 'MIN'],
  ['main', 'country', 'value', 'MAX'],
  ['main', 'country', 'value', 'COUNT'],
  ['main', 'country', 'value', 'MEDIAN'],
  ['main', 'kind', 'value', 'MODE'],
  ['main', 'indicator', 'lower_bound', 'MAX'],
  ['main', 'country', 'headcount', 'SUM'],
  ['main', 'country', 'quality_score', 'AVG'],
  ['main', 'country', 'notes', 'MODE'],
  ['main', 'country', 'notes', 'COUNT'],
  ['main', 'country', 'ingested_at', 'MIN'],
  ['main', 'country', 'ingested_at', 'MAX'],
  ['main', 'horizon', 'sample_size', 'SUM'],
  ['geography', 'departement', 'population', 'SUM'],
  ['geography', 'commune', 'density', 'AVG'],
  ['geography', 'commune', 'population', 'MEDIAN'],
  ['geography', 'region', 'date', 'MAX'],
  ['geography', 'region', 'is_urban', 'MODE'],
  ['geography', 'region', 'budget', 'SUM'],
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getAggregates reproduit getAggregatedFacts (un agrégat, un groupBy)', () => {
  test.each(CASES)('%s : %s, %s(%s)', async (schema, groupBy, measure, aggregation) => {
    const result = await execute(server, {
      query: `query {
        getAggregates(
          schema: "${schema}"
          groupBy: [{ field: "${groupBy}" }]
          aggregates: [{ measure: "${measure}", aggregation: ${aggregation}, alias: "v" }]
          limit: 1000
        ) { data total }
      }`,
    });
    expect(result.errors).toBeUndefined();
    const payload = result.data!.getAggregates as {
      data: Record<string, unknown>[];
      total: number;
    };

    const expected = await referenceRows(schema, groupBy, measure, aggregation);
    // Clé en chaîne comme l'ancienne API (null préservé), valeur et effectif identiques
    expect(
      payload.data.map((row) => ({
        key: row[groupBy] === null ? null : String(row[groupBy]),
        aggregatedValue: row.v,
        count: row.row_count,
      })),
    ).toEqual(
      expected.map((row) => ({
        key: row.key === null ? null : String(row.key),
        aggregatedValue: row.aggregatedValue,
        count: Number(row.count),
      })),
    );
    expect(payload.total).toBe(await referenceTotal(schema, groupBy));
  });
});
