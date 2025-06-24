// Importation des modules
import { FactQueryLoader } from './base-loader.js';
import { buildWhereClause } from '../utils/utils.js';

// Classe de chargement des faits agrégés
/**
 * Loader for aggregated fact queries
 * Extends FactQueryLoader for common SQL building functionality
 */
class AggregatedFactsLoader extends FactQueryLoader {
    // Initialisation
    constructor() {
        super({
            batchSize: 5,
            cachePrefix: 'aggregated-facts',
            cache: true,
            cacheTimeout: 300 // 5 minutes
        });
    }

    // Association des opérations à des fonctions SQL
    /**
     * Maps aggregation types to SQL functions
     */
    static AGGREGATION_MAP = {
        SUM: 'SUM',
        AVG: 'AVG',
        MAX: 'MAX',
        MIN: 'MIN',
        COUNT: 'COUNT',
        MEDIAN: 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value)',
        MODE: 'MODE'
    };

    // Méthode de chargement des faits agrégés
    /**
     * Loads aggregated fact data
     * @param {Object} connection - Database connection
     * @param {Object} params - Query parameters
     * @returns {Promise<Array>} Aggregated results
     */
    async loadAggregatedFacts(connection, params) {
        const { 
            fields, 
            filters, 
            structuredFilters, 
            groupBy, 
            aggregation,
            limit,
            offset,
            sort = []
        } = params;

        // Validation des paramètres
        this.validatePagination(limit, offset);

        // Construction de la condition de filtre
        const whereClause = buildWhereClause(filters, structuredFilters);
        
        // Obtention de la fonction d'agrégation SQL
        const aggregationQuery = AggregatedFactsLoader.AGGREGATION_MAP[aggregation] || 'SUM';

        // Construction du critère de tri
        const sortClause = sort.length > 0 
            ? `ORDER BY ${sort.map(s => 
                s.field === 'key' ? 'key' : `aggregatedValue ${s.order}`
            ).join(', ')}` 
            : '';

        // Construction de la requête
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
        
        console.log('Executing aggregated facts query:', query);
        
        // Exécution de la requête
        const results = await connection.all(query);
        console.log(`Query returned ${results ? results.length : 0} rows`);
        
        // Mise en forme du jeu de données
        return results.map(row => ({
            ...row,
            key: String(row.key),
            aggregatedValue: Number(row.aggregatedValue),
            count: Number(row.count)
        }));
    }
}

// Fonction de création d'un loader pour la table des faits agrégée
/**
 * Creates a DataLoader for aggregated facts
 * @returns {DataLoader} DataLoader instance for aggregated facts
 */
const createAggregatedFactsLoader = () => {
    const loader = new AggregatedFactsLoader();
    return loader.createLoader((connection, params) => loader.loadAggregatedFacts(connection, params));
};

export { createAggregatedFactsLoader };