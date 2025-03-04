// loaders/metadata.js
const DataLoader = require('dataloader');
const { dbPool } = require('../db');
const { withCache } = require('../utils/cache');

// Fonction de chargement des méta-données
/**
 * Creates a DataLoader for metadata
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
                const results = await connection.all(query, [name]);
                
                console.log(`Query result for ${name}:`, results);
                
                // Retourne le premier résultat s'il existe, et null sinon
                return results && results.length > 0 ? results[0] : null;
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
            dbPool.release(connection);
        }
    }
}, {
    maxBatchSize: 10,
    cache: true
});

exports.createMetadataLoader = createMetadataLoader;