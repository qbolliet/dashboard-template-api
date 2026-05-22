// Importation des modules
import { DuckDBInstance, DuckDBConnection, Json } from '@duckdb/node-api';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** DuckLake catalog entry to attach to the shared DuckDB instance. */
export interface CatalogEntry {
  path: string;
  alias: string;
  readOnly: boolean;
  dataPath?: string;
}

/** Configuration for the DuckDB connection pool. */
export interface PoolConfig {
  catalogs: CatalogEntry[];
  maxConnections: number;
  acquireTimeout: number;
  retryDelay: number;
  /** Max wait (ms) for in-flight requests to drain on reload before force-close. */
  drainTimeout?: number;
}

/** Query result with column metadata, intended for D3 visualization. */
export interface WithMetadataResult {
  columns: string[];
  data: Record<string, Json>[];
  metadata: {
    count: number;
    extents: Record<string, [number, number]>;
  };
}

/** Connection wrapper exposing DuckDB query methods. */
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
  // Connexions de l'ancienne instance en cours de drainage après un reload
  private draining: ConnectionWrapper[];
  // Garde anti-concurrence pour reload() (déduplique les appels simultanés)
  private reloadPromise: Promise<void> | null;
  // Délai max d'attente du drainage des requêtes en vol avant fermeture forcée.
  // Doit dépasser le plus long timeout de requête (cf. API.TIMEOUTS, max 15s).
  private readonly drainTimeout: number;

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
    // Ensemble des connexions de l'ancienne instance en attente de fermeture
    this.draining = [];
    // Garde de reload en cours
    this.reloadPromise = null;
    // Délai de drainage configurable (défaut 30s, > timeout max de requête)
    this.drainTimeout = poolConfig.drainTimeout ?? 30000;
  }

  /**
   * Build a fresh DuckDB instance with all DuckLake catalogs attached.
   * Pure factory: does not mutate pool state, so a failure here leaves any
   * currently-serving instance untouched (used by both lazy init and reload).
   *
   * @returns A newly created DuckDB instance with every catalog attached.
   */
  private async buildInstance(): Promise<DuckDBInstance> {
    // Création d'une instance DuckDB en mémoire partagée
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();

    try {
      // Chargement de ducklake
      await conn.run('LOAD ducklake;');

      // Support S3 : chargement de httpfs si activé dans la config
      if (config.S3?.ENABLED) {
        await conn.run('INSTALL httpfs FROM core; LOAD httpfs;');
        // Échappement SQL des valeurs de configuration S3
        const esc = (v: string | undefined | null): string => (v ?? '').replace(/'/g, "''");
        const secretParts: string[] = [
          `TYPE S3`,
          `REGION '${esc(config.S3?.REGION ?? 'eu-west-1')}'`,
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
        await conn.run(`CREATE OR REPLACE SECRET _api_s3 (${secretParts.join(', ')});`);
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
        await conn.run(`ATTACH 'ducklake:${catalog.path}' AS "${catalog.alias}"${optionClause}`);
      }
    } finally {
      conn.closeSync();
    }

    return instance;
  }

  /**
   * Initialize the single shared DuckDB instance and attach all DuckLake catalogs.
   * Uses a lazy singleton pattern: safe to call multiple times from concurrent
   * acquire() calls — the first call initializes, subsequent calls wait on the
   * same Promise.
   *
   * @returns The shared DuckDB instance.
   */
  async initializeInstance(): Promise<DuckDBInstance> {
    // Retour immédiat si l'instance est déjà prête
    if (this.instance) return this.instance;
    // Réutilisation de la Promise en cours si l'initialisation est déjà démarrée
    if (this.instancePromise) return this.instancePromise;

    // Démarrage de l'initialisation unique
    this.instancePromise = (async (): Promise<DuckDBInstance> => {
      try {
        const instance = await this.buildInstance();
        // Stockage de l'instance pour les appels suivants
        this.instance = instance;
        return instance;
      } catch (error) {
        // Réinitialisation de la garde pour autoriser une nouvelle tentative
        // (sinon une Promise rejetée serait mise en cache et casserait le pool)
        this.instancePromise = null;
        throw error;
      }
    })();

    return this.instancePromise;
  }

  /**
   * Rebuild the shared instance against the latest catalog state on disk / S3.
   *
   * Used after an external process refreshes the DuckLake catalogs: the running
   * pool keeps serving the snapshot it attached at startup, so a reload is needed
   * to pick up new data without restarting the pod.
   *
   * Zero-interruption strategy:
   *  1. Build the new instance first — if it fails (S3 down, corrupt catalog),
   *     the old instance keeps serving and the error propagates to the caller.
   *  2. Atomically swap it in so new acquisitions use the fresh catalog.
   *  3. Drain and close the old instance in the background, letting in-flight
   *     requests finish on a clean per-request boundary.
   *
   * Resolves only once the new instance is ready, so callers can safely sequence
   * a cache invalidation afterwards.
   */
  async reload(): Promise<void> {
    // Déduplication des reloads concurrents
    if (this.reloadPromise) return this.reloadPromise;

    this.reloadPromise = (async (): Promise<void> => {
      const dbLogger = createContextLogger({ component: 'database', module: 'pool' });
      try {
        dbLogger.database('Reloading DuckDB instance (re-attaching catalogs)', {
          catalogs: this.catalogs.map((c) => c.alias),
        });

        // 1. Construction de la nouvelle instance AVANT toute mutation d'état
        const newInstance = await this.buildInstance();

        // 2. Bascule atomique : les nouvelles acquisitions utilisent le catalogue à jour
        const oldInstance = this.instance;
        const oldConnections = this.pool;
        this.instance = newInstance;
        this.instancePromise = Promise.resolve(newInstance);
        this.pool = [];

        // 3. Drainage et fermeture de l'ancienne instance en arrière-plan
        void this.drainAndClose(oldInstance, oldConnections);

        dbLogger.database('DuckDB instance reloaded successfully', {
          drainingConnections: oldConnections.length,
        });
      } finally {
        // Libération de la garde, succès comme échec
        this.reloadPromise = null;
      }
    })();

    return this.reloadPromise;
  }

  /**
   * Wait for in-flight requests on a retired instance to finish, then close it.
   * Connections still in use are tracked in {@link draining} so that release()
   * can flag them done; after the drain window elapses they are force-closed.
   *
   * @param oldInstance - The retired DuckDB instance to close.
   * @param oldConnections - Connections bound to the retired instance.
   */
  private async drainAndClose(
    oldInstance: DuckDBInstance | null,
    oldConnections: ConnectionWrapper[],
  ): Promise<void> {
    const dbLogger = createContextLogger({ component: 'database', module: 'pool' });

    // Suivi des connexions en drainage pour que release() puisse les marquer libres
    this.draining.push(...oldConnections);

    // Attente que les requêtes en vol se terminent, plafonnée par drainTimeout
    const deadline = Date.now() + this.drainTimeout;
    while (oldConnections.some((c) => c.inUse) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
    }

    const stillBusy = oldConnections.filter((c) => c.inUse).length;
    if (stillBusy > 0) {
      dbLogger.warn('Force-closing in-flight connections after drain timeout', {
        stillBusy,
        drainTimeout: this.drainTimeout,
      });
    }

    // Fermeture des anciennes connexions puis de l'ancienne instance
    const results = await Promise.allSettled(oldConnections.map((c) => c.close()));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        dbLogger.error(`Failed to close drained connection #${i}`, result.reason);
      }
    });

    if (oldInstance) {
      try {
        oldInstance.closeSync();
      } catch (error) {
        dbLogger.error('Failed to close retired DuckDB instance', error);
      }
    }

    // Retrait des connexions drainées du suivi
    this.draining = this.draining.filter((c) => !oldConnections.includes(c));
  }

  /**
   * Acquire a connection from the pool or create a new one.
   * Connections are reused when available (marked inUse = false).
   * If the pool is at capacity, waits with polling until a connection is freed.
   *
   * @returns A connection wrapper with query methods.
   * @throws {Error} If acquisition times out.
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
        reject(new Error(`Connection acquisition timeout after ${this.acquireTimeout}ms`));
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
             * @param prepared - The prepared statement to bind to.
             * @param param - The value to bind.
             * @param paramIndex - 1-based parameter index.
             */
            const bindParam = (
              prepared: Awaited<ReturnType<DuckDBConnection['prepare']>>,
              param: unknown,
              paramIndex: number,
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
               * @param query - SQL query to execute.
               * @param params - Parameters for prepared statement.
               * @returns Query results as array of row objects.
               */
              all: async (
                query: string,
                params: unknown[] = [],
              ): Promise<Record<string, Json>[]> => {
                if (params.length > 0) {
                  const prepared = await duckdbConnection.prepare(query);
                  params.forEach((param, i) => bindParam(prepared, param, i + 1));
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
               * @param query - SQL query to execute.
               * @param params - Parameters for prepared statement.
               * @returns Query results as JSON array of arrays.
               */
              getAsJsonArray: async (query: string, params: unknown[] = []): Promise<Json[][]> => {
                if (params.length > 0) {
                  const prepared = await duckdbConnection.prepare(query);
                  params.forEach((param, i) => bindParam(prepared, param, i + 1));
                  const result = await prepared.run();
                  return result.getRowsJson();
                }
                const result = await duckdbConnection.run(query);
                return result.getRowsJson();
              },

              /**
               * Execute a query and return D3-friendly result with column metadata.
               *
               * @param query - SQL query to execute.
               * @param params - Parameters for prepared statement.
               * @returns Data with columns, rows, count, and numeric extents.
               */
              getWithMetadata: async (
                query: string,
                params: unknown[] = [],
              ): Promise<WithMetadataResult> => {
                let result;
                if (params.length > 0) {
                  const prepared = await duckdbConnection.prepare(query);
                  params.forEach((param, i) => bindParam(prepared, param, i + 1));
                  result = await prepared.run();
                } else {
                  result = await duckdbConnection.run(query);
                }

                const columnNames = result.columnNames();
                const rows = await result.getRowObjectsJson();

                // Calcul de l'extent (min/max) pour les colonnes numériques
                const extents = columnNames.reduce<Record<string, [number, number]>>((acc, col) => {
                  const values = rows
                    .map((r) => r[col])
                    .filter((v): v is number => typeof v === 'number' && v !== null);
                  if (values.length > 0) {
                    acc[col] = [Math.min(...values), Math.max(...values)];
                  }
                  return acc;
                }, {});

                return {
                  columns: columnNames,
                  data: rows,
                  metadata: { count: rows.length, extents },
                };
              },

              /**
               * Execute a SQL statement without returning results (DDL, utilities).
               *
               * @param query - SQL statement to execute.
               */
              exec: async (query: string): Promise<void> => {
                await duckdbConnection.run(query);
              },

              /**
               * Close this specific connection.
               */
              close: async (): Promise<void> => {
                duckdbConnection.closeSync();
              },
            };

            // Ajout de la connexion à l'ensemble
            this.pool.push(newConnection);
            resolve(newConnection);
          } else {
            // Attente d'une connexion disponible si le pool est à saturation
            waitInterval = setInterval(() => {
              const availableConnection = this.pool.find((conn) => !conn.inUse);
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
      },
    );

    // Course entre l'acquisition et le timeout
    return Promise.race([acquirePromise, timeoutPromise]);
  }

  /**
   * Release a connection back to the pool.
   *
   * @param connection - The connection wrapper to release.
   */
  release(connection: ConnectionWrapper): void {
    const connIndex = this.pool.findIndex((conn) => conn.conn === connection.conn);
    if (connIndex >= 0) {
      // Marquage comme disponible pour la prochaine acquisition
      this.pool[connIndex].inUse = false;
      return;
    }
    // Connexion appartenant à une instance retirée (reload en cours) : on la marque
    // libre pour que le drainage puisse la fermer dès la fin de la requête en vol.
    const drainIndex = this.draining.findIndex((conn) => conn.conn === connection.conn);
    if (drainIndex >= 0) {
      this.draining[drainIndex].inUse = false;
    }
  }

  /**
   * Close all connections and the shared DuckDB instance.
   */
  async close(): Promise<void> {
    const dbLogger = createContextLogger({ component: 'database' });

    // allSettled pour fermer toutes les connexions même si l'une échoue,
    // y compris celles encore en cours de drainage après un reload
    const allConnections = [...this.pool, ...this.draining];
    const results = await Promise.allSettled(allConnections.map((conn) => conn.close()));
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
    this.draining = [];
    this.instance = null;
    this.instancePromise = null;
  }
}

export { DuckDBPool };
