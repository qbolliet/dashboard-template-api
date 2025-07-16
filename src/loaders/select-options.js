// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';

// Classe de chargement des options de sélection
/**
 * Loader for select options (dropdown values)
 * Extends BaseQueryLoader for common functionality
 */
class SelectOptionsLoader extends BaseQueryLoader {
    // Initialisation
    constructor() {
        super({
            batchSize: config.API.LOADERS.BATCH_SIZE,
            cachePrefix: 'select-options',
            cache: true,
            cacheTimeout: config.API.LOADERS.SELECT_OPTIONS_CACHE_TIMEOUT // 10 minutes pour les options qui changent peu
        });
    }

    // Méthode de chargement des options de sélections
    /**
     * Loads select options for a field
     * @param {Object} connection - Database connection
     * @param {Object} params - Query parameters
     * @returns {Promise<Array>} Array of select options
     */
    async loadSelectOptions(connection, { fieldName, limit, searchTerm }) {
        try {
            // Vérification si le champ est catégoriel
            const metadataQuery = 'SELECT is_categorical FROM metadata WHERE name = ?';
            const metadataResults = await connection.all(metadataQuery, [fieldName]);
            const isCategorical = metadataResults.length > 0 && metadataResults[0].is_categorical;
            
            if (isCategorical) {
                // Chargement depuis la table de dimension
                return await this.loadFromDimension(connection, fieldName, limit, searchTerm);
            } else {
                // Chargement des valeurs distinctes depuis la table de faits
                return await this.loadFromFacts(connection, fieldName, limit, searchTerm);
            }
        } catch (error) {
            return [];
        }
    }

    // Méthode de chargement depuis la table des dimensions
    /**
     * Loads options from dimension table
     * @private
     */
    async loadFromDimension(connection, fieldName, limit, searchTerm) {
        // Construction de la requête
        let query = `SELECT value, label FROM dim_${fieldName}`;
        const params = [];
        
        // Ajout du terme de recherche si présent
        if (searchTerm) {
            query += ' WHERE LOWER(label) LIKE LOWER(?)';
            params.push(`%${searchTerm}%`);
        }
        
        // Ajout de la limite
        query += ' LIMIT ?';
        params.push(limit);
        
        // Exécution de la requête
        const results = await connection.all(query, params);
        
        // Mise en forme du résultat
        return results.map(row => ({
            value: String(row.value),
            label: row.label
        }));
    }

    // Méthode de chargement depuis la table des faits
    /**
     * Loads options from fact table
     * @private
     */
    async loadFromFacts(connection, fieldName, limit, searchTerm) {
        // Construction de la requête
        let query = `SELECT DISTINCT ${fieldName} as value FROM fact_table`;
        const params = [];
        
        // Ajout du terme de recherche si présent
        if (searchTerm) {
            query += ' WHERE CAST(${fieldName} AS VARCHAR) LIKE ?';
            params.push(`%${searchTerm}%`);
        }
        
        // Ajout de la limite
        query += ' LIMIT ?';
        params.push(limit);
        
        // Exécution de la requête
        const results = await connection.all(query, params);
        
        // Mise en forme du résultat
        return results.map(row => ({
            value: String(row.value),
            label: String(row.value)
        }));
    }
}

// Fonction de création d'un loader pour les sélections d'options
/**
 * Creates a DataLoader for select options
 * @returns {DataLoader} DataLoader instance for select options
 */
const createSelectOptionsLoader = () => {
    const loader = new SelectOptionsLoader();
    return loader.createLoader((connection, params) => loader.loadSelectOptions(connection, params));
};

export { createSelectOptionsLoader };