// Importation des modules
import DataLoader from 'dataloader';
import { dbPool } from '../db/index.js';
import { withCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';

// Classe de base pour la requête d'une base de données
/**
 * Base class for all data loaders
 * Provides common functionality for database connection management,
 * caching, and error handling
 */
class BaseQueryLoader {
    // Initialisation
    /**
     * Creates a new BaseQueryLoader instance
     * @param {Object} config - Configuration object
     * @param {number} config.batchSize - Maximum batch size for DataLoader
     * @param {string} config.cachePrefix - Prefix for cache keys
     * @param {boolean} config.cache - Whether to enable caching
     */
    constructor(config = {}) {
        this.batchSize = config.batchSize || 5;
        this.cachePrefix = config.cachePrefix || 'default';
        this.cacheEnabled = config.cache !== false;
        this.cacheTimeout = config.cacheTimeout || 300; // 5 minutes par défaut
    }

    // Méthode exécutant une fonction à partir d'une connexion à la base de données
    /**
     * Executes a function with a database connection
     * Handles connection acquisition and release automatically
     * @param {Function} queryFn - Function that receives a connection
     * @returns {Promise<any>} Result of the query function
     */
    async executeWithConnection(queryFn) {
        let connection;
        try {
            // Acquisition de la connexion
            connection = await dbPool.acquire();
            // Exécution de la fonction avec la connexion
            return await queryFn(connection);
        } catch (error) {
            logger.error(`Error in ${this.cachePrefix} loader:`, error);
            throw error;
        } finally {
            // Libération de la connexion
            if (connection) {
                dbPool.release(connection);
            }
        }
    }

    // Méthode de chargement de données avec mise en cache
    /**
     * Loads data with caching support
     * @param {any} key - Cache key
     * @param {Function} loader - Function that loads the data
     * @returns {Promise<any>} Cached or fresh data
     */
    async loadWithCache(key, loader) {
        if (!this.cacheEnabled) {
            return loader();
        }

        const cacheKey = `${this.cachePrefix}:${JSON.stringify(key)}`;
        return withCache(cacheKey, loader, this.cacheTimeout);
    }

    // Méthode de création d'un loader
    /**
     * Creates a DataLoader instance with common configuration
     * @param {Function} loadFn - Function that loads data for given keys
     * @param {Object} options - Additional DataLoader options
     * @returns {DataLoader} Configured DataLoader instance
     */
    createLoader(loadFn, options = {}) {
        return new DataLoader(async (keys) => {
            return this.executeWithConnection(async (connection) => {
                return Promise.all(keys.map(async (key) => {
                    try {
                        return await this.loadWithCache(
                            key,
                            () => loadFn(connection, key)
                        );
                    } catch (error) {
                        logger.error(`Error loading ${this.cachePrefix} for key:`, key, error);
                        // Retourne null ou tableau vide selon le contexte
                        return Array.isArray(key) ? [] : null;
                    }
                }));
            });
        }, {
            maxBatchSize: this.batchSize,
            cacheKeyFn: key => JSON.stringify(key),
            cache: true,
            ...options
        });
    }

    // Méthode de création d'un loader pouvant effectuer de multiples requêtes en batch
    /**
     * Creates a DataLoader for batch operations
     * Optimized for queries that can be batched together
     * @param {Function} batchLoadFn - Function that loads data for multiple keys at once
     * @param {Object} options - Additional DataLoader options
     * @returns {DataLoader} Configured DataLoader instance
     */
    createBatchLoader(batchLoadFn, options = {}) {
        return new DataLoader(async (keys) => {
            return this.executeWithConnection(async (connection) => {
                try {
                    // Pour les opérations batch, on peut optimiser en une seule requête
                    const results = await batchLoadFn(connection, keys);
                    
                    // S'assurer que le résultat est dans le même ordre que les clés
                    return keys.map((key, index) => results[index] || null);
                } catch (error) {
                    logger.error(`Batch error in ${this.cachePrefix} loader:`, error);
                    // En cas d'erreur, retourner des valeurs par défaut pour chaque clé
                    return keys.map(() => null);
                }
            });
        }, {
            maxBatchSize: this.batchSize,
            cacheKeyFn: key => JSON.stringify(key),
            cache: true,
            ...options
        });
    }
}


// Classe de base pour requêter la table des faits
/**
 * Base class for fact-related loaders
 * Provides common functionality for building SQL queries
 */
class FactQueryLoader extends BaseQueryLoader {
    // Méthode de construction de la sélection des colonnes en SQL
    /**
     * Builds SELECT clause from fields array
     * @param {Array<string>} fields - Fields to select
     * @returns {string} SQL SELECT clause
     */
    buildSelectClause(fields) {
        return fields && fields.length > 0 ? fields.join(', ') : '*';
    }

    // Méthode de construction de l'ordonnancement des lignes en SQL
    /**
     * Builds ORDER BY clause from sort array
     * @param {Array<Object>} sort - Sort configuration
     * @returns {string} SQL ORDER BY clause
     */
    buildSortClause(sort) {
        if (!sort || sort.length === 0) return '';
        return `ORDER BY ${sort.map(s => `${s.field} ${s.order}`).join(', ')}`;
    }

    // Méthode de validation des paramètres de pagination
    /**
     * Validates pagination parameters
     * @param {number} limit - Maximum number of results
     * @param {number} offset - Number of results to skip
     * @throws {Error} If parameters are invalid
     */
    validatePagination(limit, offset) {
        if (limit > 1000) {
            throw new Error('Limit cannot exceed 1000');
        }
        if (offset > 10000) {
            throw new Error('Offset cannot exceed 10000');
        }
    }
}

export { BaseQueryLoader, FactQueryLoader };