// Importation des modules
import DataLoader from 'dataloader';
import { dbPool } from '../db/index.js';
import { withCache } from '../utils/cache.js';
import { buildWhereClause } from '../utils/utils.js';

// Fonction d'agrégation de la table des faits
/**
 * Creates a DataLoader for aggregated facts
 * @returns {DataLoader} DataLoader instance for aggregated facts
 */
const createAggregatedFactsLoader = () => new DataLoader(async (keys) => {
    // Initialisation de la connexion
    let connection;

    try {
    // Acquisition de la connexion à la base de données
    connection = await dbPool.acquire();
    // console.log('Successfully acquired database connection for aggregated facts');

    // Implémentation de chaque paramètre de requête
    return await Promise.all(keys.map(async ({ 
        fields, 
        filters, 
        structuredFilters, 
        groupBy, 
        aggregation,
        limit,
        offset,
        sort = [],
    }) => {
        try {
            // Création de la clé de cache
            const cacheKey = `aggregated-facts:${JSON.stringify({ 
                fields, 
                filters, 
                structuredFilters, 
                groupBy, 
                aggregation,
                limit,
                offset,
                sort 
            })}`;
            
            // Utilisation du cache s'il existe
            return await withCache(cacheKey, async () => {
                // Création de la condition de filtre sur les données
                const whereClause = buildWhereClause(filters, structuredFilters);
                
                // Correspondance entre les fonctions d'agrégation et leur implémentation en SQL
                const aggregationMap = {
                    SUM: 'SUM',
                    AVG: 'AVG',
                    MAX: 'MAX',
                    MIN: 'MIN',
                    COUNT: 'COUNT',
                    MEDIAN: 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value)',
                    MODE: 'MODE'
                };
                
                // Création de la requête d'agrégation
                const aggregationQuery = aggregationMap[aggregation] || 'SUM';

                // Construction du critère de tri
                const sortClause = sort.length > 0 
                ? `ORDER BY ${sort.map(s => 
                    s.field === 'key' ? 'key' : `aggregatedValue ${s.order}`
                ).join(', ')}` 
                : '';

                // Construction de la requête à partir de l'ensemble des paramètres
                const query = `
                SELECT 
                    ${groupBy} as key, 
                    ${aggregationQuery}(value) as aggregatedValue,
                    COUNT(*) as count
                FROM fact_table
                ${whereClause}
                GROUP BY ${groupBy}
                ${sortClause}
                LIMIT ${limit} OFFSET ${offset}
                `;
                
                //console.log('Executing aggregated facts query:', query);
                
                // Exécution de la requête
                const results = await connection.all(query);
                //console.log(`Query returned ${results ? results.length : 0} rows`);
                
                // Mise en forme du jeu de données pour assurer un type consistant
                return results.map(row => ({
                    ...row,
                    key: String(row.key),
                    aggregatedValue: Number(row.aggregatedValue),
                    count: Number(row.count)
                }));
            });
        } catch (queryError) {
            console.error('Error executing aggregated facts query:', queryError);
            throw queryError;
        }
    }));
    } catch (error) {
        // Retorune une erreur
        //console.error('Error in aggregated facts loader:', error);
        throw error;
    } finally {
        // Retourne pas défaut la connexion s'il en existe une disponible
        if (connection) {
            console.log('Releasing database connection');
            dbPool.release(connection);
        }
    }
}, {
    maxBatchSize: 5,
    cacheKeyFn: key => JSON.stringify(key)
});

// Export
export { createAggregatedFactsLoader };