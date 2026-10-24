// Importation des modules
import { GraphQLError } from 'graphql';
import { previewValue } from './preview-value.js';

// ─── Identifiants SQL ────────────────────────────────────────────────────────

/**
 * Quotes a SQL identifier for DuckDB.
 *
 * The name is wrapped in double quotes and every double quote it contains is
 * doubled, so any column name the database accepts — spaces, accents,
 * apostrophes, quotes, reserved words — becomes a single, inert identifier.
 * Quoting is the only protection needed against injection through an
 * identifier; whether the column EXISTS is checked separately against the
 * metadata table by {@link assertColumns}.
 *
 * @param name - Raw identifier.
 * @returns The quoted identifier, ready to interpolate.
 */
// Mise entre guillemets d'un identifiant (guillemets internes doublés)
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Separator of the levels of a nested schema path (`sales.europe`). */
const SCHEMA_PATH_SEPARATOR = '.';

/**
 * Builds the fully qualified name of a DuckLake table.
 *
 * Catalog and schema come from allow-lists (configuration, discovery), the
 * table from a constant; every part is quoted all the same, so a schema whose
 * name is not a bare identifier still resolves.
 *
 * The schema is a path: since DuckLake 1.1, schemas can be nested, and a
 * nested schema is named by its levels joined with a dot (`sales.europe`, as
 * reported by {@link SCHEMA_PATHS_CTE}). Each level is quoted on its own, so
 * the qualified name reads: the catalog before the first dot, the table after
 * the last one, the schema in between. A flat schema whose own name contains
 * a dot is therefore read as a nested path, and cannot be served.
 *
 * @param catalog - Catalog alias.
 * @param schema - Schema path within the catalog (`main`, `sales.europe`).
 * @param table - Table name (fact_table, metadata, dataset_metadata).
 * @returns `"catalog"."schema"."table"`, or `"catalog"."sales"."europe"."table"`.
 */
// Nom qualifié d'une table : catalogue, niveaux du schéma et table quotés
function qualifiedTable(catalog: string, schema: string, table: string): string {
  return [catalog, ...schema.split(SCHEMA_PATH_SEPARATOR), table].map(quoteIdent).join('.');
}

/**
 * Recursive CTE `schema_paths` giving the full path of every schema of the
 * attached databases.
 *
 * `duckdb_schemas()` and `information_schema.schemata` only report the last
 * level of a nested schema (`europe` for `sales.europe`): the path is rebuilt
 * by walking up `parent_schema_oid`. Columns: `database_name`, `schema_oid`,
 * `parent_oid` and `schema_path`; only the rows with `parent_oid IS NULL`
 * carry a complete path (the others are intermediate steps of the walk).
 */
// Chemin complet de chaque schéma, en remontant ses parents
const SCHEMA_PATHS_CTE = `WITH RECURSIVE schema_paths(database_name, schema_oid, parent_oid, schema_path) AS (
  SELECT database_name, oid, parent_schema_oid, schema_name FROM duckdb_schemas()
  UNION ALL
  SELECT p.database_name, p.schema_oid, s.parent_schema_oid,
         s.schema_name || '${SCHEMA_PATH_SEPARATOR}' || p.schema_path
  FROM schema_paths p JOIN duckdb_schemas() s ON s.oid = p.parent_oid
)`;

/**
 * Checks that every requested column is declared in the metadata table.
 *
 * The single gate before a client-supplied column name reaches the SQL: an
 * unknown column is a client error (BAD_USER_INPUT) listing every offending
 * name at once, never a DuckDB binder error. A non-string or empty name counts
 * as unknown.
 *
 * @param names - Column names to check.
 * @param metadataByName - Metadata rows of the target schema, keyed by name.
 * @param context - Role of the columns, quoted in the message (e.g. 'field', 'sort').
 * @throws {GraphQLError} BAD_USER_INPUT when at least one column is unknown.
 */
// Contrôle des colonnes demandées contre la table metadata
function assertColumns(
  names: readonly unknown[],
  metadataByName: ReadonlyMap<string, unknown>,
  context: string,
): void {
  const unknown = [
    ...new Set(
      names
        .filter((name) => typeof name !== 'string' || name === '' || !metadataByName.has(name))
        .map((name) => String(name)),
    ),
  ];
  if (unknown.length > 0) {
    throw new GraphQLError(
      `Unknown ${context} column(s): ${unknown.map((name) => previewValue(name)).join(', ')}. ` +
        'They do not exist in the metadata table.',
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
}

export { quoteIdent, qualifiedTable, assertColumns, SCHEMA_PATHS_CTE, SCHEMA_PATH_SEPARATOR };
