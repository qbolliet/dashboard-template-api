// Importation des modules
import { typeFamilyOf } from '../utils/metadata-mapping.js';
import type { FieldMetadata } from '../utils/metadata-mapping.js';
import type { DatasetInfo } from '../loaders/dataset-info.js';
import type { Aggregation, TimeGrain } from '../generated/graphql.js';

// ─── Métadonnées embarquées dans les fichiers exportés ───────────────────────

/**
 * Metadata a parquet or arrow export carries about itself.
 *
 * The technical column names alone do not make a file self-describing: the
 * label, unit and display format of each column, the label columns that go
 * with a code column, and the description of the dataset all live in the
 * `metadata` and `dataset_metadata` tables. Both are already loaded to build
 * the query, so they are embedded at no extra cost. An aggregated export also
 * describes how its columns were computed (`database.aggregation`).
 */

/** A group column of an aggregated export. */
interface ExportGroupColumn {
  /** Output column (the source column, truncated when grained). */
  name: string;
  grain: TimeGrain | null;
  /** Output column holding the labels of the group (`<name>__label`), or null. */
  labelColumn: string | null;
  /** Source label column read by ANY_VALUE, or null. */
  labelField: string | null;
}

/** An aggregate column of an aggregated export. */
interface ExportAggregateColumn {
  /** Output column. */
  alias: string;
  measure: string;
  aggregation: Aggregation;
  /** Unit of the aggregate (none for COUNT). */
  unit: string | null;
  /** d3-format string of the aggregate. */
  displayFormat: string | null;
}

/** How the rows of an aggregated export were computed. */
interface ExportAggregation {
  groupBy: ExportGroupColumn[];
  aggregates: ExportAggregateColumn[];
  /** Name of the COUNT(*) column, or null when absent. */
  rowCountColumn: string | null;
}

/** What an export knows about the columns it sends and the dataset they come from. */
interface ExportDescription {
  /**
   * Metadata of the exported columns (all of them when no projection is asked);
   * for an aggregated export, of its source columns: groups, labels, measures.
   */
  columns: FieldMetadata[];
  dataset: DatasetInfo;
  /** Set on an aggregated export only. */
  aggregation?: ExportAggregation;
}

// Clés des paires clé/valeur : Parquet (KV_METADATA) et schéma Arrow
const METADATA_KEY = 'database.metadata';
const DATASET_KEY = 'database.dataset';
const AGGREGATION_KEY = 'database.aggregation';

/**
 * Serializes the `database.metadata` value: the JSON array of the metadata
 * rows in camelCase, each with its `typeFamily`.
 *
 * @param columns - Metadata of the exported columns.
 * @returns A JSON array, one object per column.
 */
function serializeColumns(columns: readonly FieldMetadata[]): string {
  return JSON.stringify(columns.map((c) => ({ ...c, typeFamily: typeFamilyOf(c.sqlType) })));
}

/**
 * Builds the key/value pairs embedded in the file.
 *
 * @param description - Columns and dataset of the export.
 * @returns `database.metadata` (JSON array of column rows),
 *   `database.dataset` (JSON object of the DatasetInfo) and, for an
 *   aggregated export, `database.aggregation` (JSON of its groups and aggregates).
 */
// Mêmes clés pour Parquet et Arrow : une seule recette de lecture côté client
function embeddedMetadata(description: ExportDescription): Record<string, string> {
  return {
    [METADATA_KEY]: serializeColumns(description.columns),
    [DATASET_KEY]: JSON.stringify(description.dataset),
    ...(description.aggregation
      ? { [AGGREGATION_KEY]: JSON.stringify(description.aggregation) }
      : {}),
  };
}

/**
 * Key/value pairs of one metadata row, absent values left out rather than
 * written empty, so that a reader tests for the key. `isPrimaryKey` is always
 * present.
 *
 * @param column - Metadata row of the column.
 * @returns The key/value pairs of the field.
 */
function columnPairs(column: FieldMetadata): Map<string, string> {
  const entries: [string, string | null][] = [
    ['label', column.label],
    ['unit', column.unit],
    ['displayFormat', column.displayFormat],
    ['description', column.description],
    ['isPrimaryKey', String(column.isPrimaryKey)],
    ['labelFor', column.labelFor],
  ];
  return new Map(entries.filter((e): e is [string, string] => e[1] !== null));
}

/**
 * Per-field metadata of an export, keyed by output column: the display
 * contract of each column (label, unit, displayFormat, description,
 * isPrimaryKey, labelFor).
 *
 * A raw export describes each column by its metadata row. An aggregated one
 * describes its group columns the same way, each label column by its source
 * label column (`labelFor` naming the group column), and each aggregate by its
 * measure, with the unit and format of the aggregate plus `measure` and
 * `aggregation`. A column without metadata (row_count) gets none.
 *
 * @param description - Columns, dataset and aggregation of the export.
 * @returns The key/value pairs of each described field.
 */
// Métadonnées par champ, indexées par colonne de sortie
function fieldDescriptions(description: ExportDescription): Map<string, Map<string, string>> {
  const byName = new Map(description.columns.map((c) => [c.name, c]));
  const aggregation = description.aggregation;

  // Description simple si absence d'agrégation
  if (!aggregation) {
    return new Map(description.columns.map((c) => [c.name, columnPairs(c)]));
  }

  const fields = new Map<string, Map<string, string>>();
  // Parcours des dimensions d'agrégation
  for (const group of aggregation.groupBy) {
    // Ajout du nom et des labels associés à chaque champ
    const source = byName.get(group.name);
    if (source) fields.set(group.name, columnPairs(source));
    const label = group.labelField ? byName.get(group.labelField) : undefined;
    if (group.labelColumn && label) {
      fields.set(group.labelColumn, columnPairs({ ...label, labelFor: group.name }));
    }
  }
  // Parcours des agrégats
  for (const aggregate of aggregation.aggregates) {
    // Ajout de la mesure et de son alias
    const measure = byName.get(aggregate.measure);
    if (!measure) continue;
    const pairs = columnPairs({
      ...measure,
      unit: aggregate.unit,
      displayFormat: aggregate.displayFormat,
      isPrimaryKey: false,
      labelFor: null,
    });
    pairs.set('measure', aggregate.measure);
    pairs.set('aggregation', aggregate.aggregation);
    fields.set(aggregate.alias, pairs);
  }
  return fields;
}

export { AGGREGATION_KEY, DATASET_KEY, METADATA_KEY, embeddedMetadata, fieldDescriptions };
export type { ExportAggregateColumn, ExportAggregation, ExportDescription, ExportGroupColumn };
