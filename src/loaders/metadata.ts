// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import type { DuckDBConnection } from './base-loader.js';

// ─── Interfaces de méta-données ───────────────────────────────────────────────

/** Row of the metadata table returned by DuckDB. */
interface MetadataRow {
    name: string;
    is_categorical?: boolean;
    is_primary_key?: boolean;
    [key: string]: unknown;
}

// Classe de chargement des méta-données
/**
 * Loader for metadata table queries.
 *
 * Extends BaseQueryLoader to load field metadata (type, categorical flag,
 * primary key flag) from the metadata table of the current catalog.
 */
class MetadataLoader extends BaseQueryLoader {

    // Initialisation avec la configuration spécifique aux méta-données
    /**
     * Creates a MetadataLoader bound to a specific database.
     *
     * @param databaseId - Catalog alias to query; null uses the default database.
     */
    constructor(databaseId: string | null = null) {
        super({
            batchSize: config.API.LOADERS.BATCH_SIZE,
            cachePrefix: 'metadata',
            cache: true,
            // Durée de mise en cache plus longue car les méta-données changent rarement
            cacheTimeout: config.API.LOADERS.METADATA_CACHE_TIMEOUT,
            databaseId
        });
    }

    // Méthode de chargement des méta-données pour une seule variable
    /**
     * Loads metadata for a single field name.
     *
     * Converts is_categorical and is_primary_key columns from integer
     * to boolean before returning.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param name - Field name to look up in the metadata table.
     * @returns Metadata row for the given name, or null when not found.
     */
    async loadSingle(connection: DuckDBConnection, name: string): Promise<MetadataRow | null> {
        // Paramétrisation de la requête pour éviter les injections SQL
        const query = `SELECT * FROM ${this.qualifyTable('metadata')} WHERE name = ?`;

        // Exécution de la requête
        const result = await connection.all(query, [name]);

        // Absence de résultat → retour null
        if (!result || result.length === 0) {
            return null;
        }

        // Conversion des indicateurs booléens stockés en entier
        const metadata = result[0] as MetadataRow;
        if (metadata && 'is_categorical' in metadata) {
            metadata.is_categorical = Boolean(metadata.is_categorical);
        }
        if (metadata && 'is_primary_key' in metadata) {
            metadata.is_primary_key = Boolean(metadata.is_primary_key);
        }

        return metadata;
    }
}

// Fonction de création d'un loader pour les méta-données
/**
 * Creates a DataLoader for metadata lookups.
 *
 * @param databaseId - Catalog alias to query; null uses the default database.
 * @returns DataLoader keyed by field name, returning MetadataRow or null.
 */
const createMetadataLoader = (databaseId: string | null = null) => {
    const loader = new MetadataLoader(databaseId);
    return loader.createLoader<string, MetadataRow | null>(
        (connection, name) => loader.loadSingle(connection, name)
    );
};

export { createMetadataLoader };
export type { MetadataRow };
