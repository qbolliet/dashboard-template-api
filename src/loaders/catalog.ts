// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { config } from '../utils/config-loader.js';
import { METADATA_SELECT, toFieldMetadata, withLabelFields } from '../utils/metadata-mapping.js';
import type { DuckDBConnection } from './base-loader.js';
import type { FieldMetadata } from '../utils/metadata-mapping.js';

// ─── Interfaces des résultats catalog ────────────────────────────────────────

/** Catalog + schema pair used as the DataLoader key for catalog-level queries. */
interface CatalogSchemaKey {
  catalog: string;
  /** DuckLake schema; null/undefined uses the catalog's configured default. */
  schema?: string | null;
}

// Classe de chargement des méta-données d'un catalogue
/**
 * Loader for catalog-level metadata queries.
 *
 * Loads every metadata row of a given catalog/schema. Rows are returned in
 * camelCase: the snake_case → camelCase mapping lives in
 * utils/metadata-mapping.ts. `labelFields` is derived from the same rows.
 */
class CatalogMetadataLoader extends BaseQueryLoader {
  // Initialisation sans identifiant de base de données (requêtes cross-catalog)
  /**
   * Creates a CatalogMetadataLoader with no specific database binding.
   *
   * The catalog to query is passed as the DataLoader key at load time.
   */
  constructor() {
    super({
      batchSize: 1,
      cachePrefix: 'catalog-metadata',
      cache: true,
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

  // Méthode de chargement de toutes les méta-données d'un catalogue
  /**
   * Loads all metadata rows for a given catalog/schema.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param key - Catalog alias and optional schema to query.
   * @returns Array of metadata rows in camelCase, `labelFields` filled.
   */
  async loadAllMetadata(
    connection: DuckDBConnection,
    { catalog, schema }: CatalogSchemaKey,
  ): Promise<FieldMetadata[]> {
    const resolvedSchema = schema || databaseManager.getDefaultSchema(catalog);
    const query = `SELECT ${METADATA_SELECT} FROM "${catalog}".${resolvedSchema}.metadata`;
    const rows = await connection.all(query);
    // Inverse de label_for calculé sur les lignes lues, sans requête de plus
    return withLabelFields(rows.map((row) => toFieldMetadata(row)));
  }
}

// Fonction de création d'un loader pour les méta-données d'un catalogue
/**
 * Creates a DataLoader for catalog metadata queries.
 *
 * @returns DataLoader keyed by {catalog, schema}, returning FieldMetadata arrays.
 */
const createCatalogMetadataLoader = () => {
  const loader = new CatalogMetadataLoader();
  return loader.createLoader<CatalogSchemaKey, FieldMetadata[]>((connection, key) =>
    loader.loadAllMetadata(connection, key),
  );
};

export { createCatalogMetadataLoader, CatalogMetadataLoader };
export type { CatalogSchemaKey };
