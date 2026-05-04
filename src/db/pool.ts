// Importation des modules
import { DuckDBInstance, DuckDBConnection, Json } from '@duckdb/node-api';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Entrée de catalogue DuckLake à attacher à l'instance DuckDB partagée. */
export interface CatalogEntry {
    path: string;
    alias: string;
    readOnly: boolean;
    dataPath?: string;
}

/** Configuration du pool de connexions DuckDB. */
export interface PoolConfig {
    catalogs: CatalogEntry[];
    maxConnections: number;
    acquireTimeout: number;
    retryDelay: number;
}

/** Résultat d'une requête avec métadonnées pour la visualisation D3. */
export interface WithMetadataResult {
    columns: string[];
    data: Record<string, Json>[];
    metadata: {
        count: number;
        extents: Record<string, [number, number]>;
    };
}

/** Wrapper de connexion exposant les méthodes de requête DuckDB. */
export interface ConnectionWrapper {
    instance: DuckDBInstance;
    conn: DuckDBConnection;
    inUse: boolean;
    all: (query: string, params?: unknown[]) => Promise<Record<string, Json>[]>;
    getAsJsonArray: (query: string, params?: unknown[]) => Promise<Json[][]>;
    getWithMetadata: (query: string, params?: unknown[]) => Promise<WithMetadataResult>;
    exec: (query: string) => Promise<void>;
    close: () => Promise<void>;
}

// ─── Classe DuckDBPool ────────────────────────────────────────────────────────

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
    private readonly poolConfig: PoolConfig;
    pool: ConnectionWrapper[];
    readonly maxConnections: number;
    private readonly acquireTimeout: number;
    private readonly retryDelay: number;
    readonly catalogs: CatalogEntry[];
    private instance: DuckDBInstance | null;
    private instancePromise: Promise<DuckDBInstance> | null;

    // Initialisation
    constructor(poolConfig: PoolConfig) {
        // Stockage de la configuration du pool
        this.poolConfig = poolConfig;
        // Ensemble de connexions actives
        this.pool = [];
        // Nombre maximal de connexions simultanées
        this.maxConnections = poolConfig.maxConnections;
        // Timeout pour l'acquisition de la connexion
        this.acquireTimeout = poolConfig.acquireTimeout;
        // Délai d'attente entre deux tentatives quand le pool est plein
        this.retryDelay = poolConfig.retryDelay;
        // Liste des catalogues DuckLake à attacher
        this.catalogs = poolConfig.catalogs ?? [];
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
     * Returns:
     *     The shared DuckDB instance.
     */
    async initializeInstance(): Promise<DuckDBInstance> {
        // Retour immédiat si l'instance est déjà prête
        if (this.instance) return this.instance;
        // Réutilisation de la Promise en cours si l'initialisation est déjà démarrée
        if (this.instancePromise) return this.instancePromise;

        // Démarrage de l'initialisation unique
        this.instancePromise = (async (): Promise<DuckDBInstance> => {
            // Création d'une instance DuckDB en mémoire partagée
            const instance = await DuckDBInstance.create(':memory:');
            const conn = await instance.connect();

            // Chargement de ducklake
            await conn.run('LOAD ducklake;');

            // Support S3 : chargement de httpfs si activé dans la config
            if (config.S3?.ENABLED) {
                await conn.run('INSTALL httpfs FROM core; LOAD httpfs;');
                // Échappement SQL des valeurs de configuration S3
                const esc = (v: string | undefined | null): string =>
                    (v ?? '').replace(/'/g, "''");
                const secretParts: string[] = [
                    `TYPE S3`,
                    `REGION '${esc(config.S3?.REGION ?? 'eu-west-1')}'`
                ];
                if (config.S3?.ACCESS_KEY) {
                    secretParts.push(`KEY_ID '${esc(config.S3.ACCESS_KEY)}'`);
                }
                if (config.S3?.SECRET_KEY) {
                    secretParts.push(`SECRET '${esc(config.S3.SECRET_KEY)}'`);
                }
                if (config.S3?.ENDPOINT) {
                    secretParts.push(`ENDPOINT '${esc(config.S3.ENDPOINT)}'`);
                }
                await conn.run(
                    `CREATE OR REPLACE SECRET _api_s3 (${secretParts.join(', ')});`
                );
            }

            // Attachement de chaque catalogue DuckLake avec son alias et ses options
            for (const catalog of this.catalogs) {
                const options: string[] = [];
                // Chemin du répertoire de données Parquet associé au catalogue
                if (catalog.dataPath) {
                    options.push(`DATA_PATH '${catalog.dataPath}'`);
                    options.push('OVERRIDE_DATA_PATH TRUE');
                }
                // Mode lecture seule pour les catalogues de production
                if (catalog.readOnly) {
                    options.push('READ_ONLY');
                }
                const optionClause = options.length > 0 ? ` (${options.join(', ')})` : '';
                await conn.run(
                    `ATTACH 'ducklake:${catalog.path}' AS "${catalog.alias}"${optionClause}`
                );
            }

            conn.closeSync();
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
     * Returns:
     *     A connection wrapper with query methods.
     *
     * Raises:
     *     Error: If acquisition times out.
     */
    async acquire(): Promise<ConnectionWrapper> {
        const dbLogger = createContextLogger({ component: 'database' });
        dbLogger.database('Acquiring connection', { poolSize: this.pool.length });

        // Référence partagée pour nettoyer l'interval d'attente si le timeout gagne la course
        let waitInterval: ReturnType<typeof setInterval> | null = null;

        // Initialisation du timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                if (waitInterval) {
                    clearInterval(waitInterval);
                    waitInterval = null;
                }
                reject(
                    new Error(
                        `Connection acquisition timeout after ${this.acquireTimeout}ms`
                    )
                );
            }, this.acquireTimeout);
        });

        // Promesse d'acquisition de la connexion
        const acquirePromise = new Promise<ConnectionWrapper>(
            // eslint-disable-next-line no-async-promise-executor
            async (resolve, reject) => {
                try {
                    // Recherche d'une connexion existante et non utilisée
                    const connection = this.pool.find((conn) => !conn.inUse);
                    // Réutilisation si disponible
                    if (connection) {
                        connection.inUse = true;
                        return resolve(connection);
                    }

                    // Création d'une nouvelle connexion si le pool n'est pas plein
                    if (this.pool.length < this.maxConnections) {
                        // Initialisation paresseuse de l'instance partagée (idempotente)
                        const instance = await this.initializeInstance();

                        // Nouvelle connexion à l'instance partagée
                        const duckdbConnection = await instance.connect();

                        /**
                         * Helper to bind a single parameter to a prepared statement.
                         *
                         * Args:
                         *     prepared: The prepared statement to bind to.
                         *     param: The value to bind.
                         *     paramIndex: 1-based parameter index.
                         */
                        const bindParam = (
                            prepared: Awaited<ReturnType<DuckDBConnection['prepare']>>,
                            param: unknown,
                            paramIndex: number
                        ): void => {
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
                                // Conversion en string pour les types complexes
                                prepared.bindVarchar(paramIndex, String(param));
                            }
                        };

                        // Création d'un wrapper exposant les méthodes de requête
                        const newConnection: ConnectionWrapper = {
                            instance,
                            conn: duckdbConnection,
                            inUse: true,

                            /**
                             * Execute a query and return results as objects.
                             * Uses native DuckDB JSON methods for BigInt handling.
                             *
                             * Args:
                             *     query: SQL query to execute.
                             *     params: Parameters for prepared statement.
                             *
                             * Returns:
                             *     Query results as array of row objects.
                             */
                            all: async (
                                query: string,
                                params: unknown[] = []
                            ): Promise<Record<string, Json>[]> => {
                                if (params.length > 0) {
                                    const prepared =
                                        await duckdbConnection.prepare(query);
                                    params.forEach((param, i) =>
                                        bindParam(prepared, param, i + 1)
                                    );
                                    const result = await prepared.run();
                                    return result.getRowObjectsJson();
                                }
                                const result = await duckdbConnection.run(query);
                                return result.getRowObjectsJson();
                            },

                            /**
                             * Execute a query and return results as a JSON array.
                             * Optimized for D3 visualization (array of arrays).
                             *
                             * Args:
                             *     query: SQL query to execute.
                             *     params: Parameters for prepared statement.
                             *
                             * Returns:
                             *     Query results as JSON array of arrays.
                             */
                            getAsJsonArray: async (
                                query: string,
                                params: unknown[] = []
                            ): Promise<Json[][]> => {
                                if (params.length > 0) {
                                    const prepared =
                                        await duckdbConnection.prepare(query);
                                    params.forEach((param, i) =>
                                        bindParam(prepared, param, i + 1)
                                    );
                                    const result = await prepared.run();
                                    return result.getRowsJson();
                                }
                                const result = await duckdbConnection.run(query);
                                return result.getRowsJson();
                            },

                            /**
                             * Execute a query and return D3-friendly result with column metadata.
                             *
                             * Args:
                             *     query: SQL query to execute.
                             *     params: Parameters for prepared statement.
                             *
                             * Returns:
                             *     Data with columns, rows, count, and numeric extents.
                             */
                            getWithMetadata: async (
                                query: string,
                                params: unknown[] = []
                            ): Promise<WithMetadataResult> => {
                                let result;
                                if (params.length > 0) {
                                    const prepared =
                                        await duckdbConnection.prepare(query);
                                    params.forEach((param, i) =>
                                        bindParam(prepared, param, i + 1)
                                    );
                                    result = await prepared.run();
                                } else {
                                    result = await duckdbConnection.run(query);
                                }

                                const columnNames = result.columnNames();
                                const rows = await result.getRowObjectsJson();

                                // Calcul de l'extent (min/max) pour les colonnes numériques
                                const extents = columnNames.reduce<
                                    Record<string, [number, number]>
                                >((acc, col) => {
                                    const values = rows
                                        .map((r) => r[col])
                                        .filter((v): v is number =>
                                            typeof v === 'number' && v !== null
                                        );
                                    if (values.length > 0) {
                                        acc[col] = [
                                            Math.min(...values),
                                            Math.max(...values)
                                        ];
                                    }
                                    return acc;
                                }, {});

                                return {
                                    columns: columnNames,
                                    data: rows,
                                    metadata: { count: rows.length, extents }
                                };
                            },

                            /**
                             * Execute a SQL statement without returning results (DDL, utilities).
                             *
                             * Args:
                             *     query: SQL statement to execute.
                             */
                            exec: async (query: string): Promise<void> => {
                                await duckdbConnection.run(query);
                            },

                            /**
                             * Close this specific connection.
                             */
                            close: async (): Promise<void> => {
                                duckdbConnection.closeSync();
                            }
                        };

                        // Ajout de la connexion à l'ensemble
                        this.pool.push(newConnection);
                        resolve(newConnection);
                    } else {
                        // Attente d'une connexion disponible si le pool est à saturation
                        waitInterval = setInterval(() => {
                            const availableConnection = this.pool.find(
                                (conn) => !conn.inUse
                            );
                            if (availableConnection) {
                                clearInterval(waitInterval!);
                                waitInterval = null;
                                availableConnection.inUse = true;
                                resolve(availableConnection);
                            }
                        }, this.retryDelay);
                    }
                } catch (error) {
                    reject(error);
                }
            }
        );

        // Course entre l'acquisition et le timeout
        return Promise.race([acquirePromise, timeoutPromise]);
    }

    /**
     * Release a connection back to the pool.
     *
     * Args:
     *     connection: The connection wrapper to release.
     */
    release(connection: ConnectionWrapper): void {
        const connIndex = this.pool.findIndex(
            (conn) => conn.conn === connection.conn
        );
        if (connIndex >= 0) {
            // Marquage comme disponible pour la prochaine acquisition
            this.pool[connIndex].inUse = false;
        }
    }

    /**
     * Close all connections and the shared DuckDB instance.
     */
    async close(): Promise<void> {
        const dbLogger = createContextLogger({ component: 'database' });

        // allSettled pour fermer toutes les connexions même si l'une échoue
        const results = await Promise.allSettled(
            this.pool.map((conn) => conn.close())
        );
        results.forEach((result, i) => {
            if (result.status === 'rejected') {
                dbLogger.error(`Failed to close pool connection #${i}`, result.reason);
            }
        });

        // Fermeture de l'instance DuckDB partagée
        if (this.instance) {
            try {
                this.instance.closeSync();
            } catch (error) {
                dbLogger.error('Failed to close DuckDB instance', error);
            }
        }

        // Réinitialisation complète du pool
        this.pool = [];
        this.instance = null;
        this.instancePromise = null;
    }
}

export { DuckDBPool };
