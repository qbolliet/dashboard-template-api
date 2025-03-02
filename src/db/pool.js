// Importation des modules
const { DuckDBInstance } = require('@duckdb/node-api');

// Ensemble de connections
/**
 * Connection pool for DuckDB Neo API
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
        // Log des caractéristiques du pool
        console.log(`Initializing DuckDB Neo pool with database path: ${config.path}`);
        console.log(`Max connections: ${this.maxConnections}, timeout: ${this.acquireTimeout}ms`);
    }
    
    // Acquisition de la connexion
    /**
    * Acquire a connection from the pool or create a new one
    * @returns {Promise<Object>} A connection object with promise-based methods
    */
    async acquire() {
        //console.log('Attempting to acquire DB connection...');
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
                    //console.log('Reusing existing connection from pool');
                    connection.inUse = true;
                    return resolve(connection);
                }

                // Sinon, une nouvelle connexion est crée si le pool n'est pas plein
                if (this.pool.length < this.maxConnections) {
                    //console.log(`Creating new connection to: ${this.config.path}`);
                    
                    // Création d'une nouvelle instance DuckDB
                    const instance = await DuckDBInstance.create(this.config.path);
                    this.instances.push(instance);
                    
                    // Connexion à l'instance
                    const duckdbConnection = await instance.connect();
                    // console.log('Successfully connected to DuckDB');
                    
                    // Création d'un wrapper avec toute l'information sur la connexion
                    const newConnection = { 
                        instance,
                        conn: duckdbConnection,
                        inUse: true,
                        
                        // Wrapping dans une méthode qui exécute toute l'acquisition des données
                        all: async (query, params = []) => {
                            //console.log(`Executing query: ${query}`);
                            
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
                                // Récupération des résultats
                                const chunks = await result.fetchAllChunks();
                                
                                // Renvoie un array vide si aucune donnée n'a été récupérée
                                if (chunks.length === 0) {
                                    return [];
                                }
                                
                                // Convertion en ligne
                                return chunks[0].getRows();
                            } else {
                                // Pour les requêtes non paramétrées
                                // Exécution de la requête
                                const result = await duckdbConnection.run(query);
                                // Récupération du résultat
                                const chunks = await result.fetchAllChunks();
                                
                                // Renvoie un array vide si aucune donnée n'a été récupérée
                                if (chunks.length === 0) {
                                    return [];
                                }
                                
                                // Conversion en ligne
                                return chunks[0].getRows().map(row => {
                                    // Conversion en objets avec le nom des colonnes en clé
                                    const columnNames = result.columnNames();
                                    return columnNames.reduce((obj, colName, index) => {
                                        obj[colName] = row[index];
                                        return obj;
                                    }, {});
                                });
                            }
                        },
                        
                        // Méthode d'exécution d'une requête
                        exec: async (query) => {
                            //console.log(`Executing query (exec): ${query}`);
                            await duckdbConnection.run(query);
                            return;
                        },
                        
                        // Méthode de fermeture d'une connexion
                        close: async () => {
                            // console.log('Closing DuckDB connection');
                            await duckdbConnection.close();
                            // Note: This doesn't close the instance, just this connection
                        }
                    };
                    
                    // Ajout de la connexion à l'ensemble
                    this.pool.push(newConnection);
                    // Résolution de la connexion
                    resolve(newConnection);
                } else {
                    // Sinon attend qu'une connexion soit disponible
                    //console.log('Pool full, waiting for a connection to become available');
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
                //console.error('Error acquiring DuckDB connection:', error);
                reject(error);
            }
        });
        // Acquiert la connexion
        return Promise.race([acquirePromise, timeoutPromise]);
    }

    // Publication de la connexion
    /**
    * Release a connection back to the pool
    * @param {Object} connection The connection to release
    */
    release(connection) {
        // Recherche de la connexion
        const connIndex = this.pool.findIndex(conn => conn.conn === connection.conn);
        if (connIndex >= 0) {
            // Si la connexion n'est pas la denrière utilisée, elle est renvoyée dans le pool
            //console.log('Releasing connection back to pool');
            this.pool[connIndex].inUse = false;
        }
    }

    // Arrêt de la connexion
    /**
    * Close all connections in the pool
    * @returns {Promise<void>}
    */
    async close() {
        //console.log('Closing all connections in pool');

        // Clôture de l'ensemble des connexions
        await Promise.all(this.pool.map(async (conn) => {
            try {
                await conn.close();
            } catch (error) {
                console.error('Error closing connection:', error);
            }
        }));

        // Réinitialisation du pool
        this.pool = [];
        //console.log('All connections closed');
    }
}

exports.DuckDBPool = DuckDBPool;