// Importation des modules
import { typeFamilyOf } from '../utils/metadata-mapping.js';
import type { FieldMetadata } from '../utils/metadata-mapping.js';
import type { DatasetInfo } from '../loaders/dataset-info.js';

// ─── Métadonnées embarquées dans les fichiers exportés ───────────────────────

/**
 * Metadata a parquet or arrow export carries about itself.
 *
 * The technical column names alone do not make a file self-describing: the
 * label, unit and display format of each column, the label columns that go
 * with a code column, and the description of the dataset all live in the
 * `metadata` and `dataset_metadata` tables. Both are already loaded to build
 * the query, so they are embedded at no extra cost.
 */

/** What an export knows about the columns it sends and the dataset they come from. */
interface ExportDescription {
  /** Metadata of the exported columns (all of them when no projection is asked). */
  columns: FieldMetadata[];
  dataset: DatasetInfo;
}

// Clés des paires clé/valeur : Parquet (KV_METADATA) et schéma Arrow
const METADATA_KEY = 'database.metadata';
const DATASET_KEY = 'database.dataset';

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
 * @returns `database.metadata` (JSON array of column rows) and
 *   `database.dataset` (JSON object of the DatasetInfo).
 */
// Mêmes deux clés pour Parquet et Arrow : une seule recette de lecture côté client
function embeddedMetadata(description: ExportDescription): Record<string, string> {
  return {
    [METADATA_KEY]: serializeColumns(description.columns),
    [DATASET_KEY]: JSON.stringify(description.dataset),
  };
}

export { DATASET_KEY, METADATA_KEY, embeddedMetadata };
export type { ExportDescription };
