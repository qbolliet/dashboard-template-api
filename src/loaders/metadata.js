// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';

// Classe de chargement des méta-données
/**
 * Loader for metadata queries
 * Extends BaseQueryLoader for common functionality
 */
class MetadataLoader extends BaseQueryLoader {
    // Initialisation
    constructor() {
        super({
            batchSize: config.API.LOADERS.BATCH_SIZE,
            cachePrefix: 'metadata',
            cache: true,
            cacheTimeout: config.API.LOADERS.METADATA_CACHE_TIMEOUT // 10 minutes pour les méta-données qui changent rarement
        });
    }

    // Méthode de chargement des méta-données pour une seule variable
    /**
     * Loads metadata for a single name
     * @param {Object} connection - Database connection
     * @param {string} name - Metadata name to load
     * @returns {Promise<Object|null>} Metadata object or null
     */
    async loadSingle(connection, name) {
        // Paramétrisation de la requête
        const query = "SELECT * FROM metadata WHERE name = ?";
        
        // Exécution de la requête
        const result = await connection.all(query, [name]);
        
        // S'il n'y a pas de résultat, retourne null
        if (!result || result.length === 0) {
            return null;
        }
        
        // Conversion des valeurs booléennes
        const metadata = result[0];
        if (metadata && 'is_categorical' in metadata) {
            metadata.is_categorical = Boolean(metadata.is_categorical);
        }
        
        return metadata;
    }
}

// Fonction de création d'un loader pour les méta-données
/**
 * Creates a DataLoader for metadata
 * @returns {DataLoader} DataLoader instance for metadata
 */
const createMetadataLoader = () => {
    const loader = new MetadataLoader();
    return loader.createLoader((connection, name) => loader.loadSingle(connection, name));
};

export { createMetadataLoader };