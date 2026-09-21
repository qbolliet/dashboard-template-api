// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { config } from '../utils/config-loader.js';
import type { DuckDBConnection } from './base-loader.js';
import type { CatalogSchemaKey } from './catalog.js';

// ─── Interface du jeu de résultats ───────────────────────────────────────────

/**
 * The single row of the `dataset_metadata` table of a schema.
 *
 * Mirrors specification-bdd.md §2.3: `updatedAt` and `schemaVersion` are always
 * populated by the writer, the three descriptive fields are optional, and
 * `clusterBy` is the decoded form of the JSON `cluster_by` column.
 */
interface DatasetInfo {
  label: string | null;
  description: string | null;
  source: string | null;
  updatedAt: string;
  schemaVersion: number;
  clusterBy: string[];
}

// Les six colonnes de `dataset_metadata`, dans l'ordre de la spec §2.3.
// `updated_at` est un TIMESTAMP sans fuseau : la mise au format ISO 8601 se
// fait en SQL pour éviter la réinterprétation en heure locale par Node.
const DATASET_METADATA_SELECT = [
  'label',
  'description',
  'source',
  "strftime(updated_at, '%Y-%m-%dT%H:%M:%S') || 'Z' AS updated_at",
  'schema_version',
  'cluster_by',
].join(', ');

// ─── Décodage de cluster_by ──────────────────────────────────────────────────

/**
 * Decodes the JSON `cluster_by` column into a list of column names.
 *
 * A missing or malformed value yields an empty list rather than an error: the
 * physical sort order is a hint, and a dataset written without it must still be
 * readable. Callers fall back to the primary keys in that case.
 *
 * @param raw - Raw value of the cluster_by column.
 * @returns The declared sort columns, or an empty array.
 */
// Décodage tolérant : une cluster_by illisible ne doit pas rendre le schéma muet
function decodeClusterBy(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

// Classe de chargement des méta-données de jeu de résultats
/**
 * Loader for the dataset_metadata table of a catalog/schema.
 *
 * Shares the cache lifetime of the catalog metadata loader: both describe the
 * contract of a schema and are invalidated together by the catalog/schema
 * prefix (see cache/cache-invalidation.ts).
 */
class DatasetInfoLoader extends BaseQueryLoader {
  // Initialisation sans identifiant de base (le catalogue arrive par la clé)
  /**
   * Creates a DatasetInfoLoader with no specific database binding.
   *
   * The catalog to query is passed as the DataLoader key at load time.
   */
  constructor() {
    super({
      batchSize: 1,
      cachePrefix: 'dataset-info',
      cache: true,
      // Même TTL que catalogMetadata : les deux décrivent le contrat du schéma
      cacheTimeout: config.API.LOADERS.DEFAULT_CACHE_TIMEOUT,
      catalogId: null,
    });
  }

  // Garde de version appliquée à la clé, avant toute consultation du cache
  /**
   * Applies the schema version guard to the catalog/schema carried by the key.
   *
   * @param key - DataLoader key naming the catalog and schema to read.
   */
  override assertKeyAllowed(key: unknown): void {
    const { catalog, schema } = key as CatalogSchemaKey;
    assertSchemaSupported(catalog, schema || databaseManager.getDefaultSchema(catalog));
  }

  // Méthode de chargement de la ligne unique de dataset_metadata
  /**
   * Loads the dataset_metadata row of a given catalog/schema.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param key - Catalog alias and optional schema to query.
   * @returns The decoded dataset information.
   */
  async loadDatasetInfo(
    connection: DuckDBConnection,
    { catalog, schema }: CatalogSchemaKey,
  ): Promise<DatasetInfo> {
    const resolvedSchema = schema || databaseManager.getDefaultSchema(catalog);
    const query = `SELECT ${DATASET_METADATA_SELECT} FROM "${catalog}".${resolvedSchema}.dataset_metadata LIMIT 1`;
    const rows = await connection.all(query);

    // La spec §2.3 garantit exactement une ligne ; une table vide est traitée
    // comme un schéma non conforme, signalé en amont par la garde de version.
    const row = rows[0] ?? {};

    return {
      label: row.label === null || row.label === undefined ? null : String(row.label),
      description:
        row.description === null || row.description === undefined ? null : String(row.description),
      source: row.source === null || row.source === undefined ? null : String(row.source),
      updatedAt:
        row.updated_at === null || row.updated_at === undefined ? '' : String(row.updated_at),
      schemaVersion: Number(row.schema_version ?? 0),
      clusterBy: decodeClusterBy(row.cluster_by),
    };
  }
}

// Fonction de création d'un loader pour les méta-données de jeu de résultats
/**
 * Creates a DataLoader for dataset_metadata queries.
 *
 * @returns DataLoader keyed by {catalog, schema}, returning a DatasetInfo.
 */
const createDatasetInfoLoader = () => {
  const loader = new DatasetInfoLoader();
  return loader.createLoader<CatalogSchemaKey, DatasetInfo>((connection, key) =>
    loader.loadDatasetInfo(connection, key),
  );
};

export { createDatasetInfoLoader, DatasetInfoLoader, decodeClusterBy };
export type { DatasetInfo };
