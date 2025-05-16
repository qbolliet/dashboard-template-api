// Importation des modules
import DataLoader from 'dataloader';
import { dbPool } from '../db/index.js';
import { withCache } from '../utils/cache.js';

// Fonction de chargement des méta-données
/**
 * Creates a DataLoader for metadata
 * Retrieves metadata information from the database using efficient native methods
 * @returns {DataLoader} DataLoader instance for metadata
 */
const createMetadataLoader = () => new DataLoader(async (names) => {
    // Initialisation de la connexion
    let connection;
    try {
        // Acquisition de la connexion à la base de données
        connection = await dbPool.acquire();
        console.log('Successfully acquired database connection for metadata');
        
        // Utilisation de la méthode "all" pour processer plusieurs noms en parallèle
        return await Promise.all(names.map(async (name) => {
            try {
                // Création d'une clé de caching
                const cacheKey = `metadata:${name}`;
                
                // Utilisation du cache s'il existe
                return await withCache(cacheKey, async () => {
                    console.log(`Executing query for metadata name: ${name}`);
                    
                    // Paramétrisation de la requête
                    const query = "SELECT * FROM metadata WHERE name = ?";
                    
                    // Exécution de la requête en utilisant getRowsObject pour obtenir directement un format JSON
                    const result = await connection.all(query, [name]);
                    
                    // S'il n'y a pas de résultat, retourne null
                    if (!result || result.length === 0) {
                        return null;
                    }
                    
                    // Conversion des valeurs booléennes
                    // Le champ is_categorical doit être un booléen JavaScript
                    const metadata = result[0];
                    if (metadata && 'is_categorical' in metadata) {
                        metadata.is_categorical = Boolean(metadata.is_categorical);
                    }
                    
                    console.log(`Converted result for ${name}:`, metadata);
                    
                    // Retourne le premier résultat
                    return metadata;
                });
            } catch (queryError) {
                console.error(`Error executing metadata query for ${name}:`, queryError);
                return null;
            }
        }));
    } catch (error) {
        console.error('Error in metadata loader:', error);
        return names.map(() => null);
    } finally {
        if (connection) {
            console.log('Releasing connection back to pool');
            dbPool.release(connection);
        }
    }
}, {
    maxBatchSize: 10,
    cache: true
});

export { createMetadataLoader };