// Importation des modules
import { FactQueryLoader } from './base-loader.js';
import { buildWhereClause } from '../utils/utils.js';

// Classe de chargement de la table des faits
/**
 * Loader for fact table queries
 * Supports multiple formats: default, metadata, json, with-count
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
        try {
            const { 
                fields, 
                filters, 
                structuredFilters, 
                limit, 
                offset, 
                sort, 
                format = 'default',
                includeCount = false 
            } = params;
            
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
            
            // Récupération des données selon le format
            let data;
            switch (format) {
                case 'metadata':
                    // Format optimisé pour D3 avec métadonnées
                    data = await connection.getWithMetadata(query);
                    break;
                case 'json':
                    // Format JSON simple
                    data = await connection.getAsJsonArray(query);
                    break;
                default:
                    // Format par défaut - tableau d'objets
                    data = await connection.all(query);
            }
            
            // Si includeCount est demandé, ajouter le comptage total
            if (includeCount || format === 'with-count') {
                const total = await this.getCount(connection, { filters, structuredFilters });
                
                // Pour le format metadata, enrichir les métadonnées existantes
                if (format === 'metadata' && data.metadata) {
                    data.metadata = {
                        ...data.metadata,
                        total,
                        hasNextPage: offset + limit < total,
                        currentPage: Math.floor(offset / limit) + 1,
                        totalPages: Math.ceil(total / limit)
                    };
                } else {
                    // Pour les autres formats, wrapper dans un objet
                    data = {
                        data: Array.isArray(data) ? data : (data?.data || []),
                        total,
                        hasNextPage: offset + limit < total,
                        currentPage: Math.floor(offset / limit) + 1,
                        totalPages: Math.ceil(total / limit)
                    };
                }
            }
            
            return data;
        } catch (error) {
            console.error('Error in loadFacts:', error);
            throw error;
        }
    }

    // Méthode de comptage du nombre d'observations
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

// Fonction de création d'un loader pour la table des faits avec comptage
/**
 * Creates a DataLoader for facts with count
 * @returns {DataLoader} DataLoader instance for facts with count
 */
const createFactWithCountLoader = () => {
    const loader = new FactLoader();
    return loader.createLoader((connection, params) => 
        loader.loadFacts(connection, { ...params, includeCount: true })
    );
};

// Fonction de création d'un loader pour la table des faits avec métadonnées
/**
 * Creates a DataLoader for facts with D3 metadata
 * @returns {DataLoader} DataLoader instance for facts with metadata
 */
const createFactWithMetadataLoader = () => {
    const loader = new FactLoader();
    return loader.createLoader((connection, params) => 
        loader.loadFacts(connection, { ...params, format: 'metadata', includeCount: true })
    );
};

export { createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader, FactLoader };