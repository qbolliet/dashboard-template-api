// Importation des modules
import { GraphQLError } from 'graphql';
import { databaseManager } from '../db/index.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { createLoaders } from '../loaders/index.js';
import { FactLoader } from '../loaders/fact.js';
import { compileFilterTree } from '../utils/filter-tree.js';
import { resolveEffectiveSort } from '../utils/default-sort.js';
import { assertColumns, quoteIdent } from '../utils/identifiers.js';
import { indexMetadataByName } from '../utils/metadata-mapping.js';
import {
  assertCursorOrder,
  buildAfterPredicate,
  buildOrderBy,
  completeTotalOrder,
  decodeCursor,
} from './after-cursor.js';
import type { KeyColumn, SqlFragment } from './after-cursor.js';
import { ExportHttpError } from './export-params.js';
import type { ExportParams } from './export-params.js';

// ─── Cible et requête d'un export ────────────────────────────────────────────

/** Catalog and schema an export reads from, both resolved. */
interface ExportTarget {
  catalog: string;
  schema: string;
}

/** Statements of an export: the SELECT itself and its probes. */
interface ExportQuery {
  /** SELECT … LIMIT of the rows to send. */
  sql: string;
  params: unknown[];
  /** Total order of the rows, the key of the resume cursor. */
  order: KeyColumn[];
  /** Number of rows matching the request, `limit` aside (after the cursor if any). */
  count: SqlFragment;
  /**
   * Key of the row at a 0-based rank, each column as DuckDB text.
   *
   * @param offset - Rank of the row in the export order.
   * @returns The statement, one row of order.length VARCHAR columns.
   */
  boundary: (offset: number) => SqlFragment;
}

/**
 * Resolves and checks the catalog/schema of an export.
 *
 * @param params - Validated export parameters.
 * @returns The resolved target.
 * @throws {ExportHttpError} 404 for an unknown catalog or schema, 409 when the
 *   schema version is not supported (message of the version guard).
 */
// Catalogue et schéma : défauts habituels, allow-list, garde de version
function resolveExportTarget(params: ExportParams): ExportTarget {
  // Initialisation du catalogue
  let catalog: string;
  try {
    catalog = databaseManager.validateCatalogRouting(params.catalog);
  } catch (error) {
    throw new ExportHttpError(404, 'Unknown catalog', (error as Error).message);
  }

  // Initialisation du schéma
  const schema = params.schema ?? databaseManager.getDefaultSchema(catalog);
  if (!databaseManager.isValidSchema(catalog, schema)) {
    throw new ExportHttpError(
      404,
      'Unknown schema',
      `Schema '${schema}' is not available for catalog '${catalog}'. ` +
        `Available: ${databaseManager.getSchemas(catalog).join(', ')}`,
    );
  }

  try {
    assertSchemaSupported(catalog, schema);
  } catch (error) {
    throw new ExportHttpError(409, 'Unsupported schema version', (error as Error).message);
  }

  return { catalog, schema };
}

/**
 * Turns a BAD_USER_INPUT GraphQL error into a 400, leaving other errors as is.
 *
 * @param error - Error raised while building the query.
 * @returns The error to rethrow.
 */
// Les validations partagées avec GraphQL lèvent des GraphQLError BAD_USER_INPUT
function asHttpError(error: unknown): unknown {
  if (error instanceof GraphQLError) {
    const code = error.extensions?.code;
    if (code === 'BAD_USER_INPUT') {
      return new ExportHttpError(400, 'Invalid export parameter', error.message);
    }
    if (code === 'SCHEMA_VERSION_UNSUPPORTED') {
      return new ExportHttpError(409, 'Unsupported schema version', error.message);
    }
  }
  return error;
}

/**
 * Builds the statements of an export.
 *
 * Reuses the GraphQL fact path end to end: the filter tree is compiled by
 * compileFilterTree (treeToSQL, same MAX_DEPTH / MAX_CRITERIA bounds), the
 * ordering is resolved by resolveEffectiveSort (cluster_by by default, primary
 * keys as tiebreakers — the export follows the physical order at no sort
 * cost), and the SELECT list / table name come from the FactLoader builders.
 * That ordering is then completed into a total order (completeTotalOrder),
 * the key of the `after` cursor, whose predicate joins the filters.
 * Projected and sorted columns must exist in the schema metadata
 * (assertColumns), so a typo is a 400 rather than a DuckDB binder error; any
 * column name the database accepts is exported, quoted.
 *
 * @param params - Validated export parameters.
 * @param target - Resolved catalog and schema.
 * @returns The SELECT, the count and boundary probes, and the total order.
 * @throws {ExportHttpError} 400 on an unknown column, an invalid filter tree
 *   or an invalid cursor.
 */
async function buildExportQuery(params: ExportParams, target: ExportTarget): Promise<ExportQuery> {
  const { catalog, schema } = target;
  try {
    const loaders = createLoaders(catalog, schema);

    // Colonnes projetées contrôlées contre la table metadata
    const columns = await loaders.catalogMetadata.load({ catalog, schema });
    assertColumns(params.fields ?? [], indexMetadataByName(columns), 'field');

    // Arbre de filtres compilé contre les métadonnées du schéma cible
    const where = await compileFilterTree(params.filters, (names) =>
      loaders.metadata.loadMany(names),
    );
    const sort = await resolveEffectiveSort(params.sort, loaders, catalog, schema);

    // Ordre total : clé du curseur de reprise, identique d'une page à l'autre
    const order = completeTotalOrder(
      sort,
      columns.map((c) => c.name),
      columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    );

    // Filtres puis, pour une page de reprise, lignes strictement après le curseur
    const conditions: SqlFragment[] = where?.sql ? [{ sql: where.sql, params: where.params }] : [];
    if (params.after) {
      const cursor = decodeCursor(params.after);
      assertCursorOrder(cursor, order);
      conditions.push(buildAfterPredicate(order, cursor.values));
    }
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.map((c) => `(${c.sql})`).join(' AND ')}` : '';
    const whereParams = conditions.flatMap((c) => c.params);

    // Constructeurs de clauses partagés avec les requêtes GraphQL sur les faits
    const builder = new FactLoader(catalog, schema);
    const from = `FROM ${builder.qualifyTable('fact_table')} ${whereClause}`.trim();
    const orderBy = buildOrderBy(order);
    const keys = builder.buildSelectClause(order.map((k) => k.field));

    return {
      sql: `SELECT ${builder.buildSelectClause(params.fields)} ${from} ${orderBy} LIMIT ${params.limit}`,
      params: whereParams,
      order,
      count: { sql: `SELECT count(*) AS total ${from}`, params: whereParams },
      // Sous-requête : un alias « CAST(c AS VARCHAR) AS c » masquerait la
      // colonne dans l'ORDER BY, qui trierait alors le texte
      boundary: (offset) => ({
        sql:
          `SELECT ${order.map((k) => `CAST(${quoteIdent(k.field)} AS VARCHAR)`).join(', ')} ` +
          `FROM (SELECT ${keys} ${from} ${orderBy} LIMIT 1 OFFSET ${offset})`,
        params: whereParams,
      }),
    };
  } catch (error) {
    throw asHttpError(error);
  }
}

export { buildExportQuery, resolveExportTarget };
export type { ExportQuery, ExportTarget };
