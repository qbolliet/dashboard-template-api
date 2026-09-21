// ─── Contrat de la table `metadata` ──────────────────────────────────────────

/**
 * Single mapping point between the `metadata` table (snake_case columns) and
 * the GraphQL `Metadata` type (camelCase fields).
 *
 * The `metadata` table is the contract between the database and the interface
 * (specification-bdd.md §2.2): exactly eleven columns, five of them NOT NULL.
 * Every read path of that table goes through this module — the explicit column
 * projection replaces the `SELECT *` queries, and `toFieldMetadata` performs
 * the snake_case → camelCase rename together with the boolean coercion DuckDB
 * requires. Nothing else in the codebase may spell a `metadata` column name.
 */

// Les onze colonnes de la table `metadata`, dans l'ordre de la spec §2.2.
// La liste explicite remplace les SELECT * : une colonne ajoutée en base ne
// traverse plus l'API sans passer par ce module.
const METADATA_COLUMNS = [
  'name',
  'label',
  'sql_type',
  'is_primary_key',
  'is_categorical',
  'parent_name',
  'unit',
  'display_format',
  'family',
  'description',
  'default_aggregation',
] as const;

/** Projection SQL des colonnes de `metadata`, prête à interpoler. */
const METADATA_SELECT = METADATA_COLUMNS.join(', ');

/**
 * One row of the `metadata` table, in camelCase.
 *
 * The five columns declared NOT NULL by the writer (specification-bdd.md §2.2)
 * are non-optional here; the six UI fields owned by the metadata producer are
 * nullable and normalised to `null` rather than `undefined`.
 */
interface FieldMetadata {
  name: string;
  label: string;
  sqlType: string;
  isPrimaryKey: boolean;
  isCategorical: boolean;
  parentName: string | null;
  unit: string | null;
  displayFormat: string | null;
  family: string | null;
  description: string | null;
  defaultAggregation: string | null;
}

// ─── Conversion d'une ligne brute ────────────────────────────────────────────

/**
 * Normalises a nullable text column to `string | null`.
 *
 * @param value - Raw column value as returned by DuckDB.
 * @returns The value as a string, or null when absent.
 */
// Normalisation d'une colonne textuelle nullable
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Converts a raw `metadata` row into its camelCase form.
 *
 * DuckDB returns BOOLEAN columns as integers through the JSON row accessor, so
 * both flags are coerced with `Boolean`. The NOT NULL columns fall back to a
 * defined value rather than throwing: a malformed row must degrade the field,
 * never the whole schema listing.
 *
 * @param row - Raw row of the metadata table, keyed by snake_case column name.
 * @returns The same row in camelCase, with booleans and NULLs normalised.
 */
// Conversion snake_case → camelCase, unique point de traduction du contrat
function toFieldMetadata(row: Record<string, unknown>): FieldMetadata {
  return {
    name: String(row.name),
    // Repli sur le nom technique : `label` est NOT NULL en base, mais un
    // catalogue construit à la main peut l'avoir laissé vide.
    label: row.label === null || row.label === undefined ? String(row.name) : String(row.label),
    sqlType: String(row.sql_type ?? ''),
    isPrimaryKey: Boolean(row.is_primary_key),
    isCategorical: Boolean(row.is_categorical),
    parentName: nullableText(row.parent_name),
    unit: nullableText(row.unit),
    displayFormat: nullableText(row.display_format),
    family: nullableText(row.family),
    description: nullableText(row.description),
    defaultAggregation: nullableText(row.default_aggregation),
  };
}

export { METADATA_COLUMNS, METADATA_SELECT, toFieldMetadata };
export type { FieldMetadata };
