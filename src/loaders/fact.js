// Importation des modules
const DataLoader = require('dataloader');
const { dbPool } = require('../db');
const { withCache } = require('../utils/cache');
const { buildWhereClause } = require('../utils/utils');
const { redis } = require('../cache');

// Fonction de requête de la table des faits
/**
* Creates a DataLoader for facts
* @returns {DataLoader} DataLoader instance for facts
*/
const createFactLoader = () => new DataLoader(async (keys) => {
    // Initialisation de la connexion
    let connection;

    try {
        // Acquisition de la connexion à la base de données
        connection = await dbPool.acquire();
        // console.log('Successfully acquired database connection for facts');

        // Implémentation de chaque paramètre dnas la requête
        return await Promise.all(keys.map(async ({ fields, filters, structuredFilters, limit, offset, sort }) => {
            try {
                // Création d'une clé de caching
                const cacheKey = `facts:${JSON.stringify({ fields, filters, structuredFilters, limit, offset, sort })}`;
                
                // Utilisation du cache s'il existe
                return await withCache(cacheKey, async () => {
                    // Construction de la requête SQL
                    // Construction des colonnes à sélectionner
                    const selectClause = fields.length > 0
                    ? fields.join(', ')
                    : '*';
                    // Construction des filtres sur les lignes
                    const whereClause = buildWhereClause(filters, structuredFilters);
                    // Construction des critères de tri
                    const sortClause = sort.length > 0 
                    ? `ORDER BY ${sort.map(s => `${s.field} ${s.order}`).join(', ')}` 
                    : '';
                    // Construction de la requête SQL
                    const query = `
                    SELECT ${selectClause} FROM fact_table
                    ${whereClause} 
                    ${sortClause}
                    LIMIT ${limit} OFFSET ${offset}
                    `;
                    
                    //console.log('Executing fact query:', query);
                    
                    // Exécution de la requête
                    const results = await connection.all(query);
                    //console.log(`Query returned ${results ? results.length : 0} rows`);
                    
                    return results;
                });
            } catch (queryError) {
                console.error('Error executing fact query:', queryError);
                throw queryError;
            }
    }));
    } catch (error) {
        // Retourne une erreur s'il n'arrive pas à requêter les données
        console.error('Error in fact loader:', error);
        throw error;
    } finally {
        // Par défaut, retourne la connexion
        if (connection) {
            //console.log('Releasing database connection');
            dbPool.release(connection);
        }
    }
}, {
    maxBatchSize: 5,
    cacheKeyFn: key => JSON.stringify(key)
});


// Fonction additionnelle pour compter le nombre de données dans la table des faits
/**
* Fact resolver with additional count query
*/
const getFactTableWithCount = async (args) => {
    // Extraction du jeu de données
    const data = await createFactLoader().load(args);

    // Extraction du compte à partir du cache
    const countKey = `count:${JSON.stringify(args)}`;
    let total = await redis.get(countKey);

    // Si le compte n'est pas en cache, le calcule à partir de la base de données
    if (!total) {
        // Initialisation de la connexion
        let countConnection;
        try {
            // Acquisition de la connexion
            countConnection = await dbPool.acquire();
            // Construction de la condition de filtre sur les lignes
            const whereClause = buildWhereClause(args.filters, args.structuredFilters);
            // Exécution de la requête de comptage
            const countQuery = `SELECT COUNT(*) as total FROM fact_table ${whereClause}`;
            // Exécution de la requête de comptage
            const result = await countConnection.all(countQuery);
            // Extraction de la longueur du jeu de données
            total = result[0].total;
            
            // Caching du compte
            try {
                await redis.set(countKey, total, 'EX', 300);
            } catch (cacheError) {
                console.warn('Failed to cache count:', cacheError);
            }
        } catch (error) {
            console.error('Error executing count query:', error);
            // Retourne la longueur du jeu de données par défaut
            total = data.length; 
        } finally {
            if (countConnection) {
                dbPool.release(countConnection);
            }
        }
    }

    return {
        data,
        total: parseInt(total),
        hasNextPage: args.offset + args.limit < parseInt(total)
    };
};

// Export des loaders
exports.createFactLoader = createFactLoader;
exports.getFactTableWithCount = getFactTableWithCount;