// Importation des modules
import { GraphQLError } from 'graphql';
import { databaseManager } from '../db/index.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { createLoaders } from '../loaders/index.js';
import { FactLoader } from '../loaders/fact.js';
import { buildWhere, compileFilterTree } from '../utils/filter-tree.js';
import { resolveEffectiveSort } from '../utils/default-sort.js';
import { ExportHttpError } from './export-params.js';
import type { ExportParams } from './export-params.js';

// ─── Cible et requête d'un export ────────────────────────────────────────────

/** Catalog and schema an export reads from, both resolved. */
interface ExportTarget {
  catalog: string;
  schema: string;
}

/** Parameterized SELECT of an export. */
interface ExportQuery {
  sql: string;
  params: unknown[];
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
 * Builds the SELECT of an export.
 *
 * Reuses the GraphQL fact path end to end: the filter tree is compiled by
 * compileFilterTree (treeToSQL, same MAX_DEPTH / MAX_CRITERIA bounds), the
 * ordering is resolved by resolveEffectiveSort (cluster_by by default, primary
 * keys as tiebreakers — the export follows the physical order at no sort
 * cost), and the SELECT / ORDER BY / table name come from the FactLoader
 * builders. Projected and sorted columns must exist in the schema metadata,
 * so a typo is a 400 rather than a DuckDB binder error.
 *
 * @param params - Validated export parameters.
 * @param target - Resolved catalog and schema.
 * @returns The SQL text and its positional parameters.
 * @throws {ExportHttpError} 400 on an unknown column or an invalid filter tree.
 */
async function buildExportQuery(params: ExportParams, target: ExportTarget): Promise<ExportQuery> {
  const { catalog, schema } = target;
  try {
    const loaders = createLoaders(catalog, schema);

    // Colonnes connues du schéma (table metadata)
    const columns = await loaders.catalogMetadata.load({ catalog, schema });
    const known = new Set(columns.map((c) => c.name));
    const requested = [...(params.fields ?? []), ...(params.sort ?? []).map((s) => s.field)];
    const missing = [...new Set(requested.filter((name) => !known.has(name)))];
    if (missing.length > 0) {
      throw new ExportHttpError(
        400,
        'Invalid export parameter',
        `Unknown column(s) in ${catalog}.${schema}: ${missing.join(', ')}.`,
      );
    }

    // Arbre de filtres compilé contre les métadonnées du schéma cible
    const where = await compileFilterTree(params.filters, (names) =>
      loaders.metadata.loadMany(names),
    );
    const sort = await resolveEffectiveSort(params.sort, loaders, catalog, schema);

    // Constructeurs de clauses partagés avec les requêtes GraphQL sur les faits
    const builder = new FactLoader(catalog, schema);
    const sql = [
      `SELECT ${builder.buildSelectClause(params.fields)}`,
      `FROM ${builder.qualifyTable('fact_table')}`,
      buildWhere(where),
      builder.buildSortClause(sort),
      `LIMIT ${params.limit}`,
    ]
      .filter((part) => part !== '')
      .join(' ');

    return { sql, params: where?.params ?? [] };
  } catch (error) {
    throw asHttpError(error);
  }
}

export { buildExportQuery, resolveExportTarget };
export type { ExportQuery, ExportTarget };
