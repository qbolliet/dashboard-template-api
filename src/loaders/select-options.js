// src/loaders/select-options.js
const DataLoader = require('dataloader');
const { dbPool } = require('../db');
const { withCache } = require('../utils/cache');

// Fonction de requête des options de sélection
/**
 * Creates a DataLoader for select options
 * @returns {DataLoader} DataLoader instance for select options
 */
const createSelectOptionsLoader = () => new DataLoader(async (keys) => {
    let connection;

    try {
        // Acquisition de la connexion à la base de données
        connection = await dbPool.acquire();
        //console.log('Successfully acquired database connection for select options');

        // Implémentation de chaque paramètre de la requête
        return await Promise.all(keys.map(async ({ fieldName, limit, searchTerm }) => {
            try {
            // Création d'une clé de cache
            const cacheKey = `select-options:${JSON.stringify({ fieldName, limit, searchTerm })}`;
            
            // Utilisation du cache s'il existe
            return await withCache(cacheKey, async () => {
                //console.log(`Loading select options for field: ${fieldName}`);
                
                // Recherche si le champ est catégoriel en requêtant les méta-données
                const metadataQuery = 'SELECT is_categorical FROM metadata WHERE name = ?';
                const metadataResults = await connection.all(metadataQuery, [fieldName]);
                // Définition du booléen renseignant si la variable est catégorielle
                const isCategorical = metadataResults.length > 0 && metadataResults[0].is_categorical;
                
                // Si la variable est catégorielle, alors on recherche ses valeurs dans la table des dimensions
                if (isCategorical) {
                    // Initialisation de la requête de la table de dimensions
                    let query = `SELECT value, label FROM dim_${fieldName}`;
                    
                    // Initialisation de la liste des paramètres de la requête
                    const params = [];
                    
                    // Ajout du terme de recherche si ce-dernnier est renseigné
                    if (searchTerm) {
                        // Ajout de la condition sur le terme de recherche à la requête
                        query += ' WHERE LOWER(label) LIKE LOWER(?)';
                        // Ajout du terme de recherche à la liste des paramètres
                        params.push(`%${searchTerm}%`);
                    }
                    
                    // Ajout d'une limite du nombre de résultats
                    query += ' LIMIT ?';
                    // Ajout de la limite à la liste des paramètres
                    params.push(limit);
                    
                    // Exécution de la requête
                    const results = await connection.all(query, params);
                    
                    // Mise en forme de l'élément retourné
                    return results.map(row => ({
                        value: String(row.value),
                        label: row.label
                    }));
                } else {
                    // Si la variable n'est pas catégroeille, on extrait ses valeurs distinctes de la table des faits
                    // Initialisation de la requête de la table des faits
                    let query = `SELECT DISTINCT ${fieldName} as value FROM fact_table`;

                    // Initialisation de la liste des paramètres
                    const params = [];
                    
                    // Ajout du terme de recherche si ce-dernnier est renseigné
                    if (searchTerm) {
                        // Ajout de la condition sur le terme de recherche à la requête
                        query += ' WHERE CAST(value AS VARCHAR) LIKE ?';
                        // Ajout du terme de recherche à la liste des paramètres
                        params.push(`%${searchTerm}%`);
                    }
                    
                    // Ajout d'une limite du nombre de résultats
                    query += ' LIMIT ?';
                    // Ajout de la limite à la liste des paramètres
                    params.push(limit);
                    
                    // Exécution de la requête
                    const results = await connection.all(query, params);
                    
                    // Mise en forme de l'élément retourné
                    return results.map(row => ({
                        value: String(row.value),
                        label: String(row.value)
                    }));
                }
            });
            } catch (queryError) {
                // Retourne un array vide en cas d'erreur
                //console.error(`Error executing select options query for ${fieldName}:`, queryError);
                return [];
            }
        }));
    } catch (error) {
        // Retourne un array vide par défaut
        console.error('Error in select options loader:', error);
        return keys.map(() => []);
    } finally {
        // Retourne une connexion par défaut
        if (connection) {
            // console.log('Releasing database connection');
            dbPool.release(connection);
        }
    }
}, {
    maxBatchSize: 5,
    cacheKeyFn: key => JSON.stringify(key)
});

// Export
exports.createSelectOptionsLoader = createSelectOptionsLoader;