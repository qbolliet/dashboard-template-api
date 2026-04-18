// Importation des modules
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// Classe de définition d'un ensemble de connexions
/**
 * Connection pool for DuckDB with multi-catalog DuckLake support.
 * Manages a single shared DuckDB in-memory instance to which all configured
 * DuckLake catalogs are attached under distinct aliases, enabling cross-catalog
 * SQL queries (e.g. SELECT * FROM project_a.main.fact_table).
 *
 * Example:
 *   const pool = new DuckDBPool({
 *     catalogs: [
 *       { path: '/abs/a.ducklake', alias: 'project_a', readOnly: true, dataPath: '/abs/data/a/' },
 *       { path: '/abs/b.ducklake', alias: 'project_b', readOnly: true, dataPath: '/abs/data/b/' }
 *     ],
 *     maxConnections: 5,
 *     acquireTimeout: 10000,
 *     retryDelay: 50
 *   });
 *   const conn = await pool.acquire();
 *   const rows = await conn.all('SELECT * FROM project_a.main.fact_table');
 *   pool.release(conn);
 */
class DuckDBPool {
    // Initialisation
    constructor(config) {
        // Initialisation de la config
        this.config = config;
        // Initialisation de l'ensemble de connexions
        this.pool = [];
        // Nombre maximal de connexions
        this.maxConnections = config.maxConnections;
        // Timeout pour l'acquisition de la connexion
        this.acquireTimeout = config.acquireTimeout;
        // Délai d'attente entre deux tentatives quand le pool est plein
        this.retryDelay = config.retryDelay;
        // Liste des catalogues DuckLake à attacher : [{path, alias, readOnly, dataPath}]
        this.catalogs = config.catalogs || [];
        // Instance DuckDB partagée par toutes les connexions du pool
        this.instance = null;
        // Promise de garde pour éviter les initialisations concurrentes (lazy singleton)
        this.instancePromise = null;
    }

    /**
     * Initialize the single shared DuckDB instance and attach all DuckLake catalogs.
     * Uses a lazy singleton pattern: safe to call multiple times from concurrent
     * acquire() calls — the first call initializes, subsequent calls wait on the
     * same Promise.
     *
     * @returns {Promise<DuckDBInstance>} The shared DuckDB instance.
     */
    async initializeInstance() {
        // Retour immédiat si l'instance est déjà prête
        if (this.instance) return this.instance;
        // Réutilisation de la Promise en cours si l'initialisation est déjà démarrée
        // par un autre appel concurrent — évite les doubles attachements
        if (this.instancePromise) return this.instancePromise;

        // Démarrage de l'initialisation unique
        this.instancePromise = (async () => {
            // Création d'une instance DuckDB en mémoire partagée par toutes les connexions
            const instance = await DuckDBInstance.create(':memory:');
            const conn = await instance.connect();

            // Installation et chargement de l'extension DuckLake (opération unique)
            await conn.run("INSTALL ducklake FROM community; LOAD ducklake;");

            // Support S3 : chargement de l'extension httpfs si activé dans la config
            if (config.S3?.ENABLED) {
                await conn.run("INSTALL httpfs FROM core; LOAD httpfs;");
                if (config.S3.REGION) {
                    await conn.run(`SET s3_region='${config.S3.REGION}';`);
                }
                if (config.S3.ACCESS_KEY) {
                    await conn.run(`SET s3_access_key_id='${config.S3.ACCESS_KEY}';`);
                }
                if (config.S3.SECRET_KEY) {
                    await conn.run(`SET s3_secret_access_key='${config.S3.SECRET_KEY}';`);
                }
                if (config.S3.ENDPOINT) {
                    await conn.run(`SET s3_endpoint='${config.S3.ENDPOINT}';`);
                }
            }

            // Attachement de chaque catalogue DuckLake avec son alias et ses options
            for (const catalog of this.catalogs) {
                const options = [];
                // Chemin du répertoire de données Parquet associé au catalogue
                if (catalog.dataPath) {
                    options.push(`DATA_PATH '${catalog.dataPath}'`);
                }
                // Mode lecture seule pour les catalogues de production (API GraphQL)
                if (catalog.readOnly) {
                    options.push('READ_ONLY');
                }
                const optionClause = options.length > 0 ? ` (${options.join(', ')})` : '';
                await conn.run(`ATTACH 'ducklake:${catalog.path}' AS ${catalog.alias}${optionClause}`);
            }

            await conn.close();
            // Stockage de l'instance pour les appels suivants
            this.instance = instance;
            return instance;
        })();

        return this.instancePromise;
    }

    /**
     * Acquire a connection from the pool or create a new one.
     * Connections are reused when available (marked inUse = false).
     * If the pool is at capacity, waits with polling until a connection is freed.
     *
     * @returns {Promise<Object>} A connection wrapper with query methods.
     * @throws {Error} If acquisition times out.
     */
    async acquire() {
        // Initialisation du logger
        const dbLogger = createContextLogger({ component: 'database' });
        // Logging de l'acquisition
        dbLogger.database('Acquiring connection', { poolSize: this.pool.length });

        // Initialisation du timeout
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Connection acquisition timeout after ${this.acquireTimeout}ms`));
            }, this.acquireTimeout);
        });

        // Promesse d'acquisition de la connexion
        const acquirePromise = new Promise(async (resolve, reject) => {
            try {
                // Recherche d'une connexion existante et non utilisée
                const connection = this.pool.find(conn => !conn.inUse);
                // Réutilisation si disponible
                if (connection) {
                    connection.inUse = true;
                    return resolve(connection);
                }

                // Création d'une nouvelle connexion si le pool n'est pas plein
                if (this.pool.length < this.maxConnections) {

                    // Initialisation paresseuse de l'instance partagée (idempotente)
                    const instance = await this.initializeInstance();

                    // Nouvelle connexion à l'instance partagée qui a tous les catalogues attachés
                    const duckdbConnection = await instance.connect();

                    // Création d'un wrapper exposant les méthodes de requête
                    const newConnection = {
                        instance,
                        conn: duckdbConnection,
                        inUse: true,


                        /**
                         * Execute a query and return results as objects with column names as keys.
                         * Uses native DuckDB JSON methods for optimal performance and BigInt handling.
                         * Queries must use catalog-qualified table names (e.g. project_a.main.fact_table).
                         *
                         * @param {string} query - SQL query to execute.
                         * @param {Array} params - Parameters for prepared statement.
                         * @returns {Promise<Array>} Query results as array of objects.
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
                                        // Pour les types complexes, conversion en string par défaut
                                        prepared.bindVarchar(paramIndex, String(param));
                                    }
                                }

                                // Exécution
                                const result = await prepared.run();

                                // Sérialisation JSON native de DuckDB : gestion automatique des BigInt
                                return await result.getRowObjectsJson();
                            } else {
                                // Pour les requêtes non paramétrées
                                const result = await duckdbConnection.run(query);

                                // Sérialisation JSON native de DuckDB
                                return await result.getRowObjectsJson();
                            }
                        },

                        /**
                         * Execute a query and return results as a JSON array.
                         * Optimized for frontend consumption, especially for D3 visualization.
                         * Queries must use catalog-qualified table names.
                         *
                         * @param {string} query - SQL query to execute.
                         * @param {Array} params - Parameters for prepared statement.
                         * @returns {Promise<Array>} Query results as JSON array.
                         */
                        getAsJsonArray: async (query, params = []) => {
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

                            // Sérialisation JSON native en tableau de tableaux — efficace pour les gros datasets
                            return await result.getRowsJson();
                        },

                        /**
                         * Execute a query and return results in a format optimized for D3 visualization.
                         * Includes column names, row objects, count, and numeric extents.
                         * Queries must use catalog-qualified table names.
                         *
                         * @param {string} query - SQL query to execute.
                         * @param {Array} params - Parameters for prepared statement.
                         * @returns {Promise<Object>} Data formatted for D3: {columns, data, metadata}.
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

                            // Sérialisation JSON native pour de meilleures performances
                            const rows = await result.getRowObjectsJson();

                            // Format optimisé pour D3 : colonnes, données et métadonnées d'extent
                            return {
                                columns: columnNames,
                                data: rows,
                                // Métadonnées additionnelles utiles pour les échelles D3
                                metadata: {
                                    count: rows.length,
                                    // Calcul de l'extent (min/max) pour les colonnes numériques
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
                         * Execute a SQL query without returning results (DDL, utility statements).
                         *
                         * @param {string} query - SQL query to execute.
                         * @returns {Promise<void>}
                         */
                        exec: async (query) => {
                            await duckdbConnection.run(query);
                            return;
                        },

                        /**
                         * Close this specific connection.
                         *
                         * @returns {Promise<void>}
                         */
                        close: async () => {
                            await duckdbConnection.close();
                        }
                    };

                    // Ajout de la connexion à l'ensemble
                    this.pool.push(newConnection);
                    // Résolution de la promesse avec la nouvelle connexion
                    resolve(newConnection);
                } else {
                    // Attente d'une connexion disponible si le pool est à saturation
                    const checkInterval = setInterval(() => {
                        // Recherche d'une connexion libre
                        const availableConnection = this.pool.find(conn => !conn.inUse);
                        if (availableConnection) {
                            clearInterval(checkInterval);
                            availableConnection.inUse = true;
                            resolve(availableConnection);
                        }
                    }, this.retryDelay);
                }
            } catch (error) {
                reject(error);
            }
        });
        // Course entre l'acquisition et le timeout
        return Promise.race([acquirePromise, timeoutPromise]);
    }

    /**
     * Release a connection back to the pool.
     *
     * @param {Object} connection - The connection wrapper to release.
     */
    release(connection) {
        // Recherche de la connexion dans le pool par référence à la connexion DuckDB sous-jacente
        const connIndex = this.pool.findIndex(conn => conn.conn === connection.conn);
        if (connIndex >= 0) {
            // Marquage comme disponible pour la prochaine acquisition
            this.pool[connIndex].inUse = false;
        }
    }

    /**
     * Close all connections and the shared DuckDB instance.
     *
     * @returns {Promise<void>}
     */
    async close() {
        // Fermeture parallèle de toutes les connexions du pool
        await Promise.all(this.pool.map(async (conn) => {
            try {
                await conn.close();
            } catch (error) {
                throw error;
            }
        }));

        // Fermeture de l'instance DuckDB partagée
        if (this.instance) {
            try {
                await this.instance.close();
            } catch (error) {
                throw error;
            }
        }

        // Réinitialisation complète pour permettre une réutilisation éventuelle
        this.pool = [];
        this.instance = null;
        this.instancePromise = null;
    }
}

export { DuckDBPool };
