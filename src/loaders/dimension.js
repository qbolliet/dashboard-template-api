// Importation des modules
import DataLoader from 'dataloader';
import { dbPool } from '../db/index.js';
import { withCache } from '../utils/cache.js';

// Fonction de requête des données des tables de dimentions
/**
 * Creates a DataLoader for dimensions
 * @returns {DataLoader} DataLoader instance for dimensions
 */
const createDimensionLoader = () => new DataLoader(async (names) => {
    let connection;

    try {
        // Acquisition de la connexion à la base de données
        connection = await dbPool.acquire();
        //console.log('Successfully acquired database connection for dimensions');

        // Imlémentation de chaque critère de sélection
        return await Promise.all(names.map(async (name) => {
            try {
                // Création de la clé d'accès au cache
                const cacheKey = `dimension:${name}`;
                
                // Utilisation du cache s'il existe
                return await withCache(cacheKey, async () => {
                    //console.log(`Executing query for dimension: ${name}`);
                    
                    // Construction de la requête de la table de dimensions
                    const query = `SELECT * FROM dim_${name}`;
                    // Exécution de la requête de dimensions
                    const results = await connection.all(query);
                    
                    //console.log(`Query returned ${results ? results.length : 0} rows`);
                    return results;
                });
            } catch (queryError) {
                // Retourne un array vide en cas d'erreur
                console.error(`Error executing dimension query for ${name}:`, queryError);
                return [];
            }
        }));
    } catch (error) {
        // Retourne un array vide en cas d'erreur
        console.error('Error in dimension loader:', error);
        return names.map(() => []);
    } finally {
        // Retourne une connexion par défaut
        if (connection) {
            console.log('Releasing database connection');
            dbPool.release(connection);
        }
    }
}, {
    maxBatchSize: 10,
    cache: true
});

// Export
export { createDimensionLoader };