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

/**
 * Builds the fully qualified name of a DuckLake table.
 *
 * Catalog and schema come from allow-lists (configuration, discovery), the
 * table from a constant; all three are quoted all the same, so a schema whose
 * name is not a bare identifier still resolves.
 *
 * @param catalog - Catalog alias.
 * @param schema - Schema within the catalog.
 * @param table - Table name (fact_table, metadata, dataset_metadata).
 * @returns `"catalog"."schema"."table"`.
 */
// Nom qualifié d'une table : catalogue, schéma et table quotés
function qualifiedTable(catalog: string, schema: string, table: string): string {
  return [catalog, schema, table].map(quoteIdent).join('.');
}

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

export { quoteIdent, qualifiedTable, assertColumns };
