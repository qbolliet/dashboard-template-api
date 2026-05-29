// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
import { config } from '../utils/config-loader.js';
import type { DuckDBConnection } from './base-loader.js';

// ─── Interfaces des résultats catalog ────────────────────────────────────────

/** Row of the metadata table of a DuckLake catalog. */
interface CatalogMetadataRow {
  name: string;
  is_categorical: boolean;
  [key: string]: unknown;
}

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
 * Loads all metadata rows for a given catalog alias, converting the
 * is_categorical column from integer to boolean.
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

  // Méthode de chargement de toutes les méta-données d'un catalogue
  /**
   * Loads all metadata rows for a given catalog/schema.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param key - Catalog alias and optional schema to query.
   * @returns Array of CatalogMetadataRow with boolean is_categorical values.
   */
  async loadAllMetadata(
    connection: DuckDBConnection,
    { catalog, schema }: CatalogSchemaKey,
  ): Promise<CatalogMetadataRow[]> {
    const resolvedSchema = schema || databaseManager.getDefaultSchema(catalog);
    const query = `SELECT * FROM "${catalog}".${resolvedSchema}.metadata`;
    const rows = await connection.all(query);
    // Conversion du flag catégoriel stocké en entier vers boolean
    return rows.map((row) => ({
      ...row,
      is_categorical: Boolean(row.is_categorical),
    })) as CatalogMetadataRow[];
  }
}

// Classe de chargement des noms de dimensions d'un catalogue
/**
 * Loader for catalog-level dimension name queries.
 *
 * Returns the list of field names that are marked as categorical in the
 * metadata table of a given catalog.
 */
class CatalogDimensionNamesLoader extends BaseQueryLoader {
  // Initialisation sans identifiant de base de données (requêtes cross-catalog)
  /**
   * Creates a CatalogDimensionNamesLoader with no specific database binding.
   *
   * The catalog to query is passed as the DataLoader key at load time.
   */
  constructor() {
    super({
      batchSize: 1,
      cachePrefix: 'catalog-dimension-names',
      cache: true,
      cacheTimeout: config.API.LOADERS.DEFAULT_CACHE_TIMEOUT,
      catalogId: null,
    });
  }

  // Méthode de chargement des noms de dimensions d'un catalogue
  /**
   * Loads the names of all categorical fields for a given catalog/schema.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param key - Catalog alias and optional schema to query.
   * @returns Array of field names where is_categorical is true.
   */
  async loadDimensionNames(
    connection: DuckDBConnection,
    { catalog, schema }: CatalogSchemaKey,
  ): Promise<string[]> {
    const resolvedSchema = schema || databaseManager.getDefaultSchema(catalog);
    const query = `SELECT name FROM "${catalog}".${resolvedSchema}.metadata WHERE is_categorical = true`;
    const results = await connection.all(query);
    return results.map((r) => r.name as string);
  }
}

// Fonction de création d'un loader pour les méta-données d'un catalogue
/**
 * Creates a DataLoader for catalog metadata queries.
 *
 * @returns DataLoader keyed by {catalog, schema}, returning CatalogMetadataRow arrays.
 */
const createCatalogMetadataLoader = () => {
  const loader = new CatalogMetadataLoader();
  return loader.createLoader<CatalogSchemaKey, CatalogMetadataRow[]>((connection, key) =>
    loader.loadAllMetadata(connection, key),
  );
};

// Fonction de création d'un loader pour les noms de dimensions d'un catalogue
/**
 * Creates a DataLoader for catalog dimension name queries.
 *
 * @returns DataLoader keyed by {catalog, schema}, returning string arrays of dimension names.
 */
const createCatalogDimensionNamesLoader = () => {
  const loader = new CatalogDimensionNamesLoader();
  return loader.createLoader<CatalogSchemaKey, string[]>((connection, key) =>
    loader.loadDimensionNames(connection, key),
  );
};

export {
  createCatalogMetadataLoader,
  createCatalogDimensionNamesLoader,
  CatalogMetadataLoader,
  CatalogDimensionNamesLoader,
};
export type { CatalogMetadataRow, CatalogSchemaKey };
