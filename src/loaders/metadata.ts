// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import {
  METADATA_FIELD_WITH_LABELS_WHERE,
  METADATA_SELECT,
  toFieldMetadataWithLabels,
} from '../utils/metadata-mapping.js';
import type { DuckDBConnection } from './base-loader.js';
import type { FieldMetadata } from '../utils/metadata-mapping.js';

// Classe de chargement des méta-données
/**
 * Loader for metadata table queries.
 *
 * Extends BaseQueryLoader to load the metadata row of a single field from the
 * metadata table of the current catalog. Rows are returned in camelCase: the
 * snake_case → camelCase mapping lives in utils/metadata-mapping.ts. The same
 * read also returns the label columns pointing at the field, so `labelFields`
 * is derived without a second query.
 */
class MetadataLoader extends BaseQueryLoader {
  // Initialisation avec la configuration spécifique aux méta-données
  /**
   * Creates a MetadataLoader bound to a specific database.
   *
   * @param catalogId - Catalog alias to query; null uses the default catalog.
   * @param schema - DuckLake schema within the catalog; null uses the catalog default.
   */
  constructor(catalogId: string | null = null, schema: string | null = null) {
    super({
      batchSize: config.API.LOADERS.BATCH_SIZE,
      cachePrefix: 'metadata',
      cache: true,
      // Durée de mise en cache plus longue car les méta-données changent rarement
      cacheTimeout: config.API.LOADERS.METADATA_CACHE_TIMEOUT,
      catalogId,
      schema,
    });
  }

  // Méthode de chargement des méta-données pour une seule variable
  /**
   * Loads metadata for a single field name.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param name - Field name to look up in the metadata table.
   * @returns Metadata row in camelCase with its `labelFields`, or null when the
   *   field is unknown.
   */
  async loadSingle(connection: DuckDBConnection, name: string): Promise<FieldMetadata | null> {
    // Paramétrisation de la requête pour éviter les injections SQL ; la colonne
    // est lue avec ses colonnes de libellés, base du calcul de labelFields
    const query =
      `SELECT ${METADATA_SELECT} FROM ${this.qualifyTable('metadata')} ` +
      `WHERE ${METADATA_FIELD_WITH_LABELS_WHERE}`;

    // Exécution de la requête
    const result = await connection.all(query, [name, name]);

    // Absence de résultat → retour null
    if (!result || result.length === 0) {
      return null;
    }

    return toFieldMetadataWithLabels(result, name);
  }
}

// Fonction de création d'un loader pour les méta-données
/**
 * Creates a DataLoader for metadata lookups.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by field name, returning FieldMetadata or null.
 */
const createMetadataLoader = (catalogId: string | null = null, schema: string | null = null) => {
  const loader = new MetadataLoader(catalogId, schema);
  return loader.createLoader<string, FieldMetadata | null>((connection, name) =>
    loader.loadSingle(connection, name),
  );
};

export { createMetadataLoader };
export type { FieldMetadata };
