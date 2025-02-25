// loaders/metadata.js
const DataLoader = require('dataloader');
const { dbPool } = require('../db');
const { withCache } = require('../utils/cache');

// Fonction de chargement des méta-données
const createMetadataLoader = () => new DataLoader(async (names) => {
    // Initialisation de la connexion
    let connection;
    try {
        // Création de la clé de caching
        const cacheKey = `metadata:${names.join(',')}`;
        return await withCache(cacheKey, async () => {
            // Acquisition de la connexion
            connection = await dbPool.acquire();
            
            // Création de la commande de sélection du nom
            const query = "SELECT * FROM metadata";
            
            try {
                // Exécution de la requête
                const results = await connection.all(query, names);
                
                // Conversion de la réponse en Array
                const resultsArray = Array.isArray(results) ? results : [];
                
                // Renvoi du résultat
                return names.map(name => {
                    const result = resultsArray.find(r => r && r.name === name);
                    return result || null;
                });
            } catch (queryError) {
                console.error('Error executing metadata query:', queryError);
                throw queryError;
            }
        });
    } catch (error) {
        console.error('Error in metadata loader:', error);
        return names.map(() => null);
    } finally {
        if (connection) {
            dbPool.release(connection);
        }
    }
}, {
    maxBatchSize: 100,
    cache: true
});

exports.createMetadataLoader = createMetadataLoader;