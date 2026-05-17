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
      databaseId: null,
    });
  }

  // Méthode de chargement de toutes les méta-données d'un catalogue
  /**
   * Loads all metadata rows for a given catalog.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param catalogId - Catalog alias to query (e.g. 'project_a').
   * @returns Array of CatalogMetadataRow with boolean is_categorical values.
   */
  async loadAllMetadata(
    connection: DuckDBConnection,
    catalogId: string,
  ): Promise<CatalogMetadataRow[]> {
    const dm = databaseManager as { getSchema: (id: string) => string };
    const schema = dm.getSchema(catalogId);
    const query = `SELECT * FROM "${catalogId}".${schema}.metadata`;
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
      databaseId: null,
    });
  }

  // Méthode de chargement des noms de dimensions d'un catalogue
  /**
   * Loads the names of all categorical fields for a given catalog.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param catalogId - Catalog alias to query.
   * @returns Array of field names where is_categorical is true.
   */
  async loadDimensionNames(connection: DuckDBConnection, catalogId: string): Promise<string[]> {
    const dm = databaseManager as { getSchema: (id: string) => string };
    const schema = dm.getSchema(catalogId);
    const query = `SELECT name FROM "${catalogId}".${schema}.metadata WHERE is_categorical = true`;
    const results = await connection.all(query);
    return results.map((r) => r.name as string);
  }
}

// Fonction de création d'un loader pour les méta-données d'un catalogue
/**
 * Creates a DataLoader for catalog metadata queries.
 *
 * @returns DataLoader keyed by catalog alias, returning CatalogMetadataRow arrays.
 */
const createCatalogMetadataLoader = () => {
  const loader = new CatalogMetadataLoader();
  return loader.createLoader<string, CatalogMetadataRow[]>((connection, catalogId) =>
    loader.loadAllMetadata(connection, catalogId),
  );
};

// Fonction de création d'un loader pour les noms de dimensions d'un catalogue
/**
 * Creates a DataLoader for catalog dimension name queries.
 *
 * @returns DataLoader keyed by catalog alias, returning string arrays of dimension names.
 */
const createCatalogDimensionNamesLoader = () => {
  const loader = new CatalogDimensionNamesLoader();
  return loader.createLoader<string, string[]>((connection, catalogId) =>
    loader.loadDimensionNames(connection, catalogId),
  );
};

export {
  createCatalogMetadataLoader,
  createCatalogDimensionNamesLoader,
  CatalogMetadataLoader,
  CatalogDimensionNamesLoader,
};
export type { CatalogMetadataRow };
