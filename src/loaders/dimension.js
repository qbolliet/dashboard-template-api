// Importation des modules
import { BaseQueryLoader } from './base-loader.js';

// Classe de chargement des tables de dimension
/**
 * Loader for dimension tables
 * Extends BaseQueryLoader for common functionality
 */
class DimensionLoader extends BaseQueryLoader {
    // Initialisation
    constructor() {
        super({
            batchSize: 10,
            cachePrefix: 'dimension',
            cache: true,
            cacheTimeout: 600 // 10 minutes pour les dimensions qui changent rarement
        });
    }

    // Méthode de chargement d'une seule table de dimension
    /**
     * Loads dimension data for a single table
     * @param {Object} connection - Database connection
     * @param {string} name - Dimension table name
     * @returns {Promise<Array>} Array of dimension records
     */
    async loadSingle(connection, name) {
        try {
            console.log(`Executing query for dimension: ${name}`);
            
            // Construction de la requête de la table de dimensions
            const query = `SELECT * FROM dim_${name}`;
            
            // Exécution de la requête
            const results = await connection.all(query);
            
            console.log(`Query returned ${results ? results.length : 0} rows`);
            
            // Convert BIGINT values to strings for GraphQL serialization
            const convertedResults = results ? results.map(row => ({
                ...row,
                value: String(row.value)
            })) : [];
            
            return convertedResults;
        } catch (error) {
            console.error(`Error executing dimension query for ${name}:`, error);
            // Retourne un array vide en cas d'erreur
            return [];
        }
    }

    // Charge le label associé à une seule valeur
    /**
     * Loads a single dimension value with its label
     * Used for resolving labels in fact data
     * @param {Object} connection - Database connection
     * @param {Object} params - Parameters object
     * @param {string} params.dimensionName - Name of the dimension
     * @param {string} params.value - Value to look up
     * @returns {Promise<Object|null>} Dimension record or null
     */
    async loadSingleValue(connection, { dimensionName, value }) {
        try {
            const query = `SELECT value, label FROM dim_${dimensionName} WHERE value = ?`;
            const results = await connection.all(query, [value]);
            
            if (results && results.length > 0) {
                return {
                    name: dimensionName,
                    value: String(results[0].value),
                    label: results[0].label
                };
            }
            
            // Si pas trouvé dans la dimension, retourner la valeur brute
            return {
                name: dimensionName,
                value: String(value),
                label: String(value)
            };
        } catch (error) {
            console.error(`Error loading dimension value for ${dimensionName}:${value}:`, error);
            // En cas d'erreur, retourner la valeur brute
            return {
                name: dimensionName,
                value: String(value),
                label: String(value)
            };
        }
    }
}

// Fonction de création d'un loader pour les dimensions
/**
 * Creates a DataLoader for dimensions
 * @returns {DataLoader} DataLoader instance for dimensions
 */
const createDimensionLoader = () => {
    const loader = new DimensionLoader();
    return loader.createLoader((connection, name) => loader.loadSingle(connection, name));
};

// Fonction de création d'un loader pour rechercher les labels correspondant à une valeur
/**
 * Creates a DataLoader for dimension value lookups
 * Used to resolve labels for fact data
 * @returns {DataLoader} DataLoader instance for dimension values
 */
const createDimensionValueLoader = () => {
    const loader = new DimensionLoader();
    return loader.createLoader(
        (connection, params) => loader.loadSingleValue(connection, params),
        {
            cacheKeyFn: ({ dimensionName, value }) => `${dimensionName}:${value}`
        }
    );
};

export { createDimensionLoader, createDimensionValueLoader };