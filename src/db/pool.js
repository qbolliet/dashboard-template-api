// Importation des modules
import { DuckDBInstance } from '@duckdb/node-api';
import { createContextLogger } from '../utils/logger.js';

// Classe de définition d'un ensemble de connexions
/**
 * Connection pool for DuckDB Neo API
 * Manages database connections and provides optimized data access methods
 */
class DuckDBPool {
    constructor(config) {
        // Initialisation de la config
        this.config = config;
        // Initialisation de l'ensemble de connexions
        this.pool = [];
        // Nombre maximal de connexions
        this.maxConnections = config.maxConnections || 10;
        // Timeout pour l'acquisition de la connexion
        this.acquireTimeout = config.acquireTimeout || 10000; // 10 seconds
        // Instances DuckDB
        this.instances = [];
    }
    
    /**
     * Acquire a connection from the pool or create a new one
     * @returns {Promise<Object>} A connection object with promise-based methods
     */
    async acquire() {
        // Initialisation du logger
        const dbLogger = createContextLogger({ component: 'database' });
        // Logging de la connexion
        dbLogger.database('Acquiring connection', { poolSize: this.pool.length });

        // Initialisation du timout
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Connection acquisition timeout after ${this.acquireTimeout}ms`));
            }, this.acquireTimeout);
        });

        // Promesse d'acquisition de données
        const acquirePromise = new Promise(async (resolve, reject) => {
            try {
                // Regarde si une connexion existe déjà
                const connection = this.pool.find(conn => !conn.inUse);
                // SI oui, la connexion existante est réutilisée
                if (connection) {
                    connection.inUse = true;
                    return resolve(connection);
                }

                // Sinon, une nouvelle connexion est crée si le pool n'est pas plein
                if (this.pool.length < this.maxConnections) {
                    
                    // Création d'une nouvelle instance DuckDB
                    const instance = await DuckDBInstance.create(this.config.path);
                    this.instances.push(instance);
                    
                    // Connexion à l'instance
                    const duckdbConnection = await instance.connect();
                    
                    // Création d'un wrapper avec toute l'information sur la connexion
                    const newConnection = { 
                        instance,
                        conn: duckdbConnection,
                        inUse: true,
                        
                        /**
                         * Execute a query and return results as objects with column names as keys
                         * Uses native DuckDB methods for optimal performance
                         * @param {string} query - SQL query to execute
                         * @param {Array} params - Parameters for prepared statement
                         * @returns {Promise<Array>} - Query results as array of objects
                         */
                        all: async (query, params = []) => {                            
                            if (params && params.length > 0) {
                                // Préparation pour les requêtes paramétrées
                                const prepared = await duckdbConnection.prepare(query);
                                
                                // Association des paramètres suivant leur type
                                for (let i = 0; i < params.length; i++) {
                                    // Extraction de la valeur du paramètre
                                    const param = params[i];
                                    // Les paramètres sont indexés à partir de 1
                                    const paramIndex = i + 1;
                                    // Association à la requête suivant le type du paramètre
                                    if (param === null) {
                                        prepared.bindNull(paramIndex);
                                    } else if (typeof param === 'string') {
                                        prepared.bindVarchar(paramIndex, param);
                                    } else if (typeof param === 'number') {
                                        if (Number.isInteger(param)) {
                                            prepared.bindInteger(paramIndex, param);
                                        } else {
                                            prepared.bindDouble(paramIndex, param);
                                        }
                                    } else if (typeof param === 'boolean') {
                                        prepared.bindBoolean(paramIndex, param);
                                    } else {
                                        // Pour les types complexes, renvoie un string par défaut
                                        prepared.bindVarchar(paramIndex, String(param));
                                    }
                                }
                                
                                // Exécution 
                                const result = await prepared.run();
                                
                                // Utilisation de getRowsObject pour obtenir directement un tableau d'objets
                                // Cette méthode est plus efficace que la conversion manuelle
                                return await result.getRowsObject();
                            } else {
                                // Pour les requêtes non paramétrées
                                // Exécution de la requête
                                const result = await duckdbConnection.run(query);
                                
                                // Utilisation de getRowsObject pour obtenir directement un tableau d'objets
                                return await result.getRowsObject();
                            }
                        },
                        
                        /**
                         * Execute a query and return results as JSON array
                         * Optimized for frontend consumption, especially for D3 visualization
                         * @param {string} query - SQL query to execute
                         * @param {Array} params - Parameters for prepared statement
                         * @returns {Promise<Array>} - Query results as JSON array
                         */
                        getAsJsonArray: async (query, params = []) => {
                            console.log(`Executing query for JSON array: ${query}`);
                            
                            let result;
                            if (params && params.length > 0) {
                                // Préparation pour les requêtes paramétrées
                                const prepared = await duckdbConnection.prepare(query);
                                
                                // Association des paramètres suivant leur type
                                for (let i = 0; i < params.length; i++) {
                                    const param = params[i];
                                    const paramIndex = i + 1;
                                    if (param === null) {
                                        prepared.bindNull(paramIndex);
                                    } else if (typeof param === 'string') {
                                        prepared.bindVarchar(paramIndex, param);
                                    } else if (typeof param === 'number') {
                                        if (Number.isInteger(param)) {
                                            prepared.bindInteger(paramIndex, param);
                                        } else {
                                            prepared.bindDouble(paramIndex, param);
                                        }
                                    } else if (typeof param === 'boolean') {
                                        prepared.bindBoolean(paramIndex, param);
                                    } else {
                                        prepared.bindVarchar(paramIndex, String(param));
                                    }
                                }
                                
                                result = await prepared.run();
                            } else {
                                result = await duckdbConnection.run(query);
                            }
                            
                            // Obtenons les données au format JSON directement
                            // Plus efficace pour les grands ensembles de données
                            return await result.getRowsJSON();
                        },
                        
                        /**
                         * Execute a query and return results in a format optimized for D3 visualization
                         * @param {string} query - SQL query to execute
                         * @param {Array} params - Parameters for prepared statement
                         * @returns {Promise<Object>} - Data formatted for D3
                         */
                        getWithMetadata: async (query, params = []) => {                            
                            let result;
                            if (params && params.length > 0) {
                                const prepared = await duckdbConnection.prepare(query);
                                
                                for (let i = 0; i < params.length; i++) {
                                    const param = params[i];
                                    const paramIndex = i + 1;
                                    if (param === null) {
                                        prepared.bindNull(paramIndex);
                                    } else if (typeof param === 'string') {
                                        prepared.bindVarchar(paramIndex, param);
                                    } else if (typeof param === 'number') {
                                        if (Number.isInteger(param)) {
                                            prepared.bindInteger(paramIndex, param);
                                        } else {
                                            prepared.bindDouble(paramIndex, param);
                                        }
                                    } else if (typeof param === 'boolean') {
                                        prepared.bindBoolean(paramIndex, param);
                                    } else {
                                        prepared.bindVarchar(paramIndex, String(param));
                                    }
                                }
                                
                                result = await prepared.run();
                            } else {
                                result = await duckdbConnection.run(query);
                            }
                            
                            // Récupération des noms de colonnes
                            const columnNames = result.columnNames();
                            
                            // Récupération des données
                            const rows = await result.getRowsObject();
                            
                            // Format optimisé pour D3
                            // Structure qui facilite le filtrage, le tri et l'affichage
                            return {
                                columns: columnNames,
                                data: rows,
                                // Métadonnées additionnelles utiles pour D3
                                metadata: {
                                    count: rows.length,
                                    // Ajout de l'extent (min/max) pour les colonnes numériques
                                    // Très utile pour les échelles D3
                                    extents: columnNames.reduce((acc, col) => {
                                        const values = rows.map(r => r[col]).filter(v => v !== null);
                                        if (values.length > 0 && typeof values[0] === 'number') {
                                            acc[col] = [Math.min(...values), Math.max(...values)];
                                        }
                                        return acc;
                                    }, {})
                                }
                            };
                        },
                        
                        /**
                         * Execute a SQL query without returning results
                         * @param {string} query - SQL query to execute
                         * @returns {Promise<void>}
                         */
                        exec: async (query) => {
                            await duckdbConnection.run(query);
                            return;
                        },
                        
                        /**
                         * Close the database connection
                         * @returns {Promise<void>}
                         */
                        close: async () => {
                            await duckdbConnection.close();
                        }
                    };
                    
                    // Ajout de la connexion à l'ensemble
                    this.pool.push(newConnection);
                    // Résolution de la connexion
                    resolve(newConnection);
                } else {
                    // Sinon attend qu'une connexion soit disponible
                    const checkInterval = setInterval(() => {
                        // Recherche une connexion disponible et non utilisée
                        const availableConnection = this.pool.find(conn => !conn.inUse);
                        // Acquisition de la connexion disponible
                        if (availableConnection) {
                            clearInterval(checkInterval);
                            availableConnection.inUse = true;
                            resolve(availableConnection);
                        }
                    }, 500);
                }
            } catch (error) {
                reject(error);
            }
        });
        // Acquiert la connexion
        return Promise.race([acquirePromise, timeoutPromise]);
    }

    /**
     * Release a connection back to the pool
     * @param {Object} connection The connection to release
     */
    release(connection) {
        // Recherche de la connexion
        const connIndex = this.pool.findIndex(conn => conn.conn === connection.conn);
        if (connIndex >= 0) {
            // Si la connexion n'est pas la dernière utilisée, elle est renvoyée dans le pool
            this.pool[connIndex].inUse = false;
        }
    }

    /**
     * Close all connections in the pool
     * @returns {Promise<void>}
     */
    async close() {
        // Clôture de l'ensemble des connexions
        await Promise.all(this.pool.map(async (conn) => {
            try {
                await conn.close();
            } catch (error) {
                throw error;
            }
        }));

        // Réinitialisation du pool
        this.pool = [];
    }
}

export { DuckDBPool };