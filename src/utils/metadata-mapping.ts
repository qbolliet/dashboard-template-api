// Importation des modules
import { GraphQLError } from 'graphql';

// ─── Contrat de la table `metadata` ──────────────────────────────────────────

/**
 * Single mapping point between the `metadata` table (snake_case columns) and
 * the GraphQL `Metadata` type (camelCase fields).
 *
 * The `metadata` table is the contract between the database and the interface:
 * exactly twelve columns, five of them NOT NULL.
 * Every read path of that table goes through this module — the explicit column
 * projection replaces the `SELECT *` queries, and `toFieldMetadata` performs
 * the snake_case → camelCase rename together with the boolean coercion DuckDB
 * requires. Nothing else in the codebase may spell a `metadata` column name.
 */

// Les douze colonnes de la table `metadata`.
// La liste explicite remplace les SELECT * : une colonne ajoutée en base ne
// traverse plus l'API sans passer par ce module.
const METADATA_COLUMNS = [
  'name',
  'label',
  'sql_type',
  'is_primary_key',
  'is_categorical',
  'parent_name',
  'label_for',
  'unit',
  'display_format',
  'family',
  'description',
  'default_aggregation',
] as const;

/** Projection SQL des colonnes de `metadata`, prête à interpoler. */
const METADATA_SELECT = METADATA_COLUMNS.join(', ');

/**
 * Filtre SQL d'une colonne et de ses colonnes de libellés, deux paramètres
 * liés au même nom : la ligne lue suffit à calculer `labelFields`.
 */
const METADATA_FIELD_WITH_LABELS_WHERE = 'name = ? OR label_for = ?';

/**
 * One row of the `metadata` table, in camelCase.
 *
 * The five columns declared NOT NULL by the writer
 * are non-optional here; the seven UI fields owned by the metadata producer are
 * nullable and normalised to `null` rather than `undefined`. `labelFields` is
 * not a column: it is the inverse of `labelFor`, derived from the rows already
 * read by {@link withLabelFields}.
 */
interface FieldMetadata {
  name: string;
  label: string;
  sqlType: string;
  isPrimaryKey: boolean;
  isCategorical: boolean;
  parentName: string | null;
  labelFor: string | null;
  labelFields: string[];
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
 * never the whole schema listing. `labelFields` starts empty; it depends on the
 * other rows and is filled by {@link withLabelFields}.
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
    labelFor: nullableText(row.label_for),
    // Inverse de label_for : rempli par withLabelFields sur l'ensemble des lignes lues
    labelFields: [],
    unit: nullableText(row.unit),
    displayFormat: nullableText(row.display_format),
    family: nullableText(row.family),
    description: nullableText(row.description),
    defaultAggregation: nullableText(row.default_aggregation),
  };
}

// ─── Colonnes de libellés ────────────────────────────────────────

/**
 * Fills `labelFields` on every row from the `labelFor` pointers of the same set.
 *
 * `labelFields` is the inverse of `labelFor`: the label columns of a code
 * column, sorted by name. It is computed on the rows already read, so a caller
 * that needs it for one field reads that field together with the rows pointing
 * at it ({@link METADATA_FIELD_WITH_LABELS_WHERE}) — never with a second query.
 *
 * @param fields - Metadata rows of one schema, possibly a subset.
 * @returns The same rows, each carrying its sorted `labelFields`.
 */
// Calcul de l'inverse de label_for sur les lignes déjà lues
function withLabelFields(fields: FieldMetadata[]): FieldMetadata[] {
  const labelsByCode = new Map<string, string[]>();
  for (const field of fields) {
    if (field.labelFor === null) continue;
    const labels = labelsByCode.get(field.labelFor) ?? [];
    labels.push(field.name);
    labelsByCode.set(field.labelFor, labels);
  }
  return fields.map((field) => ({
    ...field,
    labelFields: [...(labelsByCode.get(field.name) ?? [])].sort(),
  }));
}

/**
 * Converts the rows of a `name = ? OR label_for = ?` read into one field.
 *
 * @param rows - Raw rows: the field itself and the label columns pointing at it.
 * @param name - Name of the field that was looked up.
 * @returns The field's metadata with `labelFields` filled, or null when unknown.
 */
// Métadonnée d'une colonne à partir de sa ligne et de celles de ses libellés
function toFieldMetadataWithLabels(
  rows: Record<string, unknown>[],
  name: string,
): FieldMetadata | null {
  return withLabelFields(rows.map(toFieldMetadata)).find((field) => field.name === name) ?? null;
}

/**
 * Indexes metadata rows by column name.
 *
 * @param fields - Metadata rows of one schema, `labelFields` filled.
 * @returns Map from column name to its metadata row.
 */
// Index des métadonnées par nom de colonne
function indexMetadataByName(
  fields: ReadonlyArray<FieldMetadata | null>,
): Map<string, FieldMetadata> {
  return new Map(
    fields.filter((field): field is FieldMetadata => field !== null).map((f) => [f.name, f]),
  );
}

/**
 * Picks the label column that renders the values of a code column.
 *
 * The single rule shared by every query: a
 * requested `labelField` must be one of the label columns of `fieldName`;
 * without one, the only label column is used, or the first by alphabetical
 * order when there are several; a column without label columns yields null
 * (`label = value`).
 *
 * @param fieldName - Code column whose values are rendered.
 * @param metadataByName - Metadata rows keyed by name, `labelFields` filled by
 *   {@link withLabelFields}. Only the entry of `fieldName` is read.
 * @param requested - Label column explicitly asked for by the client, if any.
 * @returns The effective label column, or null when the column has none.
 * @throws {GraphQLError} BAD_USER_INPUT when `requested` is not a label column
 *   of `fieldName`; the message lists the valid ones.
 */
// Règle unique de choix de la colonne de libellés
function resolveLabelField(
  fieldName: string,
  metadataByName: ReadonlyMap<string, FieldMetadata>,
  requested?: string | null,
): string | null {
  // labelFields est trié par nom : le premier est le premier alphabétique
  const candidates = metadataByName.get(fieldName)?.labelFields ?? [];

  if (requested) {
    if (candidates.includes(requested)) return requested;
    const available = candidates.length > 0 ? candidates.join(', ') : 'none';
    throw new GraphQLError(
      `'${requested}' is not a label column of '${fieldName}'. Available: ${available}`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }

  return candidates[0] ?? null;
}

export {
  METADATA_COLUMNS,
  METADATA_SELECT,
  METADATA_FIELD_WITH_LABELS_WHERE,
  toFieldMetadata,
  toFieldMetadataWithLabels,
  withLabelFields,
  indexMetadataByName,
  resolveLabelField,
};
export type { FieldMetadata };
