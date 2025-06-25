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

    // Fonction de chargement des faits aggrégés avec des méta-données
    async loadAggregatedFactsWithMetadata(connection, params) {
        // Charger les données de base
        const data = await this.loadAggregatedFacts(connection, params);
        
        // Calculer les métadonnées
        const metadata = await this.calculateMetadata(connection, data, params);
        
        return {
            data,
            metadata
        };
    }

    // Fonction de calcul des méta-données
    async calculateMetadata(connection, data, params) {
        const { groupBy } = params;
        
        // Récupération les infos sur le champ de regroupement
        const fieldMetaQuery = 'SELECT * FROM metadata WHERE name = ?';
        const fieldMeta = await connection.all(fieldMetaQuery, [groupBy]);
        
        // Calcul des extents
        const values = data.map(d => d.aggregatedValue);
        const keys = data.map(d => d.key);
        
        // Détermination des clés numériques
        const numericKeys = keys.every(k => !isNaN(parseFloat(k)));
        
        // Construction du dictionnaire de méta-données
        const metadata = {
            count: data.length,
            keyExtent: numericKeys 
                ? [Math.min(...keys.map(Number)), Math.max(...keys.map(Number))]
                : [keys[0], keys[keys.length - 1]], // Première et dernière pour les strings
            valueExtent: [Math.min(...values), Math.max(...values)],
            groupByFieldInfo: fieldMeta[0] || null
        };
        
        // Calcul des statistiques si demandé
        if (values.length > 0) {
            metadata.statistics = this.calculateStatistics(values);
        }
        
        return metadata;
    }

    // Fonction de calcul des statistiques
    calculateStatistics(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const n = sorted.length;
        
        // Moyenne
        const mean = values.reduce((a, b) => a + b, 0) / n;
        
        // Médiane
        const median = n % 2 === 0
            ? (sorted[n/2 - 1] + sorted[n/2]) / 2
            : sorted[Math.floor(n/2)];
        
        // Écart-type
        const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
        const stdDev = Math.sqrt(variance);
        
        // Quartiles
        const q1 = sorted[Math.floor(n * 0.25)];
        const q3 = sorted[Math.floor(n * 0.75)];
        
        return {
            mean,
            median,
            stdDev,
            quartiles: [sorted[0], q1, median, q3, sorted[n-1]]
        };
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

// Fonction de création d'un loader pour la table des faits agrégée avec des méta-données
const createAggregatedFactsWithMetadataLoader = () => {
    const loader = new AggregatedFactsLoader();
    return loader.createLoader(
        (connection, params) => loader.loadAggregatedFactsWithMetadata(connection, params)
    );
};

export { createAggregatedFactsLoader, createAggregatedFactsWithMetadataLoader };