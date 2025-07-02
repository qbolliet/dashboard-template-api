// Importation des modules
import { FactQueryLoader } from './base-loader.js';
import { buildWhereClause } from '../utils/utils.js';

// Classe de chargement de la table des faits
/**
 * Loader for fact table queries
 * Extends FactQueryLoader for common SQL building functionality
 */
class FactLoader extends FactQueryLoader {
    // Initialisation
    constructor() {
        super({
            batchSize: 5,
            cachePrefix: 'facts',
            cache: true,
            cacheTimeout: 300 // 5 minutes pour les faits
        });
    }

    // Méthode de chargement basée sur les paramètres de requête
    /**
     * Loads fact data based on query parameters
     * @param {Object} connection - Database connection
     * @param {Object} params - Query parameters
     * @returns {Promise<Array|Object>} Query results in requested format
     */
    async loadFacts(connection, params) {
        const { fields, filters, structuredFilters, limit, offset, sort, format = 'default' } = params;
        
        // Validation des paramètres de pagination
        this.validatePagination(limit, offset);
        
        // Construction de la requête SQL
        const selectClause = this.buildSelectClause(fields);
        const whereClause = buildWhereClause(filters, structuredFilters);
        const sortClause = this.buildSortClause(sort);
        
        const query = `
            SELECT ${selectClause} FROM fact_table
            ${whereClause} 
            ${sortClause}
            LIMIT ${limit} OFFSET ${offset}
        `;
        
        console.log('Executing fact query:', query);
        
        // Sélection du format de sortie selon les besoins du frontend
        if (format === 'metadata') {
            // Format optimisé pour D3 avec métadonnées
            return await connection.getWithMetadata(query);
        } else if (format === 'json') {
            // Format JSON simple
            return await connection.getAsJsonArray(query);
        } else {
            // Format par défaut - tableau d'objets
            return await connection.all(query);
        }
    }

    // Méthode de comptage du nombre d'observations requêtées
    /**
     * Gets total count for a fact query
     * @param {Object} connection - Database connection
     * @param {Object} filters - Filter parameters
     * @returns {Promise<number>} Total count
     */
    async getCount(connection, { filters, structuredFilters }) {
        const whereClause = buildWhereClause(filters, structuredFilters);
        const countQuery = `SELECT COUNT(*) as total FROM fact_table ${whereClause}`;
        const result = await connection.all(countQuery);
        return result[0].total;
    }
}

// Fonction de création d'un loader pour la table des faits
/**
 * Creates a DataLoader for facts
 * @returns {DataLoader} DataLoader instance for facts
 */
const createFactLoader = () => {
    const loader = new FactLoader();
    return loader.createLoader((connection, params) => loader.loadFacts(connection, params));
};



export { createFactLoader };