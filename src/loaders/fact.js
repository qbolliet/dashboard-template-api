// Importation des modules
import DataLoader from 'dataloader';
import { dbPool } from '../db/index.js';
import { withCache } from '../utils/cache.js';
import { buildWhereClause } from '../utils/utils.js';
import { redis } from '../cache/index.js';

// Fonction de requête de la table des faits
/**
 * Creates a DataLoader for facts with optimized data formats for frontend visualization
 * @returns {DataLoader} DataLoader instance for facts
 */
const createFactLoader = () => new DataLoader(async (keys) => {
    // Initialisation de la connexion
    let connection;

    try {
        // Acquisition de la connexion à la base de données
        connection = await dbPool.acquire();
        // console.log('Successfully acquired database connection for facts');

        // Implémentation de chaque paramètre dans la requête
        return await Promise.all(keys.map(async ({ fields, filters, structuredFilters, limit, offset, sort, format = 'default' }) => {
            try {
                // Création d'une clé de caching
                const cacheKey = `facts:${JSON.stringify({ fields, filters, structuredFilters, limit, offset, sort, format })}`;
                
                // Utilisation du cache s'il existe
                return await withCache(cacheKey, async () => {
                    // Construction de la requête SQL
                    // Construction des colonnes à sélectionner
                    const selectClause = fields && fields.length > 0
                        ? fields.join(', ')
                        : '*';
                    // Construction des filtres sur les lignes
                    const whereClause = buildWhereClause(filters, structuredFilters);
                    // Construction des critères de tri
                    const sortClause = sort && sort.length > 0 
                        ? `ORDER BY ${sort.map(s => `${s.field} ${s.order}`).join(', ')}` 
                        : '';
                    // Construction de la requête SQL
                    const query = `
                    SELECT ${selectClause} FROM fact_table
                    ${whereClause} 
                    ${sortClause}
                    LIMIT ${limit} OFFSET ${offset}
                    `;
                    
                    console.log('Executing fact query:', query);
                    
                    // Sélection du format de sortie selon les besoins du frontend
                    if (format === 'metadata') {
                        // Format optimisé pour D3 avec métadonnées utiles pour visualisation
                        return await connection.getWithMetadata(query);
                    } else if (format === 'json') {
                        // Format JSON simple pour consommation générale
                        return await connection.getAsJsonArray(query);
                    } else {
                        // Format par défaut - tableau d'objets
                        return await connection.all(query);
                    }
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

// Fonction de requête de la table des faits avec pagination
/**
 * Fact resolver with additional count query and pagination support
 * Optimized for frontend data display and visualization
 * @param {Object} args - Query arguments including filters and pagination
 * @returns {Promise<Object>} - Results with data, total count and pagination info
 */
const getFactTableWithCount = async (args) => {
    // Extraction du jeu de données
    const data = await createFactLoader().load(args);

    // Extraction du compte à partir du cache
    const countKey = `count:${JSON.stringify({
        filters: args.filters,
        structuredFilters: args.structuredFilters
    })}`;
    
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
            total = Array.isArray(data) ? data.length : 
                    (data && data.data ? data.data.length : 0);
        } finally {
            if (countConnection) {
                dbPool.release(countConnection);
            }
        }
    }

    // Construction du résultat selon le format des données
    if (args.format === 'metadata') {
        // Pour le format D3, incluons les informations de pagination dans les métadonnées
        return {
            ...data,
            metadata: {
                ...data.metadata,
                total: parseInt(total),
                hasNextPage: args.offset + args.limit < parseInt(total),
                currentPage: Math.floor(args.offset / args.limit) + 1,
                totalPages: Math.ceil(parseInt(total) / args.limit)
            }
        };
    } else {
        // Format standard avec informations de pagination
        return {
            data: Array.isArray(data) ? data : (data && data.data ? data.data : []),
            total: parseInt(total),
            hasNextPage: args.offset + args.limit < parseInt(total),
            currentPage: Math.floor(args.offset / args.limit) + 1,
            totalPages: Math.ceil(parseInt(total) / args.limit)
        };
    }
};

export { createFactLoader, getFactTableWithCount };