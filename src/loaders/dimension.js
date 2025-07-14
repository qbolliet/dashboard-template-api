// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';

// Classe de chargement des tables de dimension
/**
 * Loader for dimension tables
 * Extends BaseQueryLoader for common functionality
 */
class DimensionLoader extends BaseQueryLoader {
    // Initialisation
    constructor() {
        super({
            batchSize: config.API.LOADERS.BATCH_SIZE,
            cachePrefix: 'dimension',
            cache: true,
            cacheTimeout: config.API.LOADERS.DIMENSION_CACHE_TIMEOUT // 10 minutes pour les dimensions qui changent rarement
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
            
            return results || [];
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
                    value: results[0].value,
                    label: results[0].label
                };
            }
            
            // Si pas trouvé dans la dimension, retourner la valeur brute
            return {
                name: dimensionName,
                value: value,
                label: value
            };
        } catch (error) {
            console.error(`Error loading dimension value for ${dimensionName}:${value}:`, error);
            // En cas d'erreur, retourner la valeur brute
            return {
                name: dimensionName,
                value: value,
                label: value
            };
        }
    }

    // Charge plusieurs valeurs de dimension en une seule requête
    /**
     * Loads multiple dimension values in a single query
     * More efficient for batch operations
     * @param {Object} connection - Database connection
     * @param {Array} params - Array of {dimensionName, value} objects
     * @returns {Promise<Array>} Array of dimension records
     */
    async loadBatchValues(connection, params) {
        // Groupe les paramètres par dimension pour optimiser les requêtes
        const groupedParams = params.reduce((acc, param) => {
            if (!acc[param.dimensionName]) {
                acc[param.dimensionName] = [];
            }
            acc[param.dimensionName].push(param.value);
            return acc;
        }, {});

        const results = [];
        
        // Pour chaque dimension, exécute une requête batch
        for (const [dimensionName, values] of Object.entries(groupedParams)) {
            try {
                const placeholders = values.map(() => '?').join(',');
                const query = `SELECT value, label FROM dim_${dimensionName} WHERE value IN (${placeholders})`;
                const dimensionResults = await connection.all(query, values);
                
                // Crée un map pour un accès rapide
                const resultMap = new Map();
                if (dimensionResults) {
                    dimensionResults.forEach(row => {
                        resultMap.set(row.value, {
                            name: dimensionName,
                            value: row.value,
                            label: row.label
                        });
                    });
                }
                
                // Ajoute les résultats dans l'ordre des paramètres originaux
                values.forEach(value => {
                    const found = resultMap.get(value);
                    if (found) {
                        results.push(found);
                    } else {
                        results.push({
                            name: dimensionName,
                            value: value,
                            label: value
                        });
                    }
                });
            } catch (error) {
                console.error(`Error loading batch dimension values for ${dimensionName}:`, error);
                // En cas d'erreur, ajoute les valeurs brutes
                values.forEach(value => {
                    results.push({
                        name: dimensionName,
                        value: value,
                        label: value
                    });
                });
            }
        }
        
        // Retourne les résultats dans l'ordre des paramètres originaux
        return params.map(param => {
            return results.find(r => r.name === param.dimensionName && r.value === param.value);
        });
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
 * Used to resolve labels for fact data - optimized for batch operations
 * @returns {DataLoader} DataLoader instance for dimension values
 */
const createDimensionValueLoader = () => {
    const loader = new DimensionLoader();
    return loader.createBatchLoader(
        (connection, params) => loader.loadBatchValues(connection, params),
        {
            cacheKeyFn: ({ dimensionName, value }) => `${dimensionName}:${value}`,
            maxBatchSize: config.API.LOADERS.MAX_BATCH_SIZE // Augmentation de la taille de batch pour les dimensions
        }
    );
};

export { createDimensionLoader, createDimensionValueLoader };