// Importation des modules nécessaires pour la gestion des bases de données
import { DuckDBPool, type CatalogEntry } from './pool.js';
import { dirname, resolve } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// Résolution de l'emplacement du fichier et du dossier pour les chemins relatifs
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Création du logger contextualisé spécifique à ce module
const dbLogger = createContextLogger({
  component: 'database',
  module: 'database-manager',
});

// Détection des URI distantes (s3://, gs://, az://, http(s)://, …) : ces chemins
// ne doivent pas passer par resolve()/fs.existsSync (réservés au système de fichiers local).
const REMOTE_URI_PATTERN = /^[a-z0-9]+:\/\//i;
const isRemoteUri = (p: string): boolean => REMOTE_URI_PATTERN.test(p);

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Shared pool statistics returned by {@link DatabaseManager.getStatistics}. */
export interface PoolStats {
  available: number;
  using: number;
  total: number;
  maxConnections: number;
  attachedCatalogs: string[];
}

/** Full statistics snapshot for the database manager. */
export interface DatabaseStats {
  sharedPool: PoolStats | null;
  defaultCatalog: string;
  allowedCatalogs: string[];
  allowCrossCatalog: boolean;
}

// ─── Classe DatabaseManager ───────────────────────────────────────────────────

/**
 * DatabaseManager - Manages a shared DuckDB pool attached to multiple DuckLake catalogs.
 *
 * Each DuckLake catalog (one per ML pipeline / data source) is attached to a single
 * in-memory DuckDB instance under a distinct alias. A catalog may itself contain one
 * or more schemas. GraphQL resolvers route queries to the right catalog/schema by
 * prefixing table names:
 *   SELECT * FROM project_a.main.fact_table
 *
 * Configuration expected from config-loader.js:
 *   CATALOG_ROUTING:
 *     DEFAULT_CATALOG: 'project_a'
 *     ALLOWED_CATALOGS: ['project_a', 'project_b']
 *     ALLOW_CROSS_CATALOG_QUERIES: true
 *   CATALOGS:
 *     project_a:
 *       PATH: 'outputs/project_a.ducklake'
 *       DATA_PATH: 'outputs/project_a_data/'
 *       READ_ONLY: true
 *       SCHEMAS: ['main']   # liste des schémas hébergés, le 1er est le défaut
 *   DATABASE:
 *     POOL:
 *       MAX_CONNECTIONS: 5
 *       ACQUIRE_TIMEOUT: 10000
 *       POOL_RETRY_DELAY: 50
 */
class DatabaseManager {
  private readonly defaultCatalog: string;
  private readonly allowedCatalogs: string[];
  private readonly allowCrossCatalog: boolean;
  private sharedPool: DuckDBPool | null;
  // Liste effective des schémas par catalogue après réconciliation discovery↔config
  // (allow-list utilisée par isValidSchema, getSchemas et l'introspection).
  private schemas: Record<string, string[]>;
  // Liste configurée par catalogue (snapshot statique du démarrage), utilisée par
  // initSchemas() pour ré-appliquer la politique d'intersection après chaque reload.
  private readonly configuredSchemas: Record<string, string[]>;
  // Catalogues dont SCHEMAS est explicitement fourni en config (allow-list stricte).
  // Sert au reconcilier post-ATTACH : ces catalogues sont restreints à l'intersection
  // (config ∩ découverte), tandis que les autres adoptent la liste découverte.
  private readonly explicitlyConfiguredSchemas: Set<string>;

  constructor() {
    // Configuration du routage des catalogues depuis le fichier de config
    this.defaultCatalog = config.CATALOG_ROUTING.DEFAULT_CATALOG;

    // ALLOWED_CATALOGS peut être une string JSON ou un tableau selon le config-loader
    const rawAllowed = config.CATALOG_ROUTING.ALLOWED_CATALOGS;
    this.allowedCatalogs =
      typeof rawAllowed === 'string' ? (JSON.parse(rawAllowed) as string[]) : rawAllowed;

    this.allowCrossCatalog = config.CATALOG_ROUTING.ALLOW_CROSS_CATALOG_QUERIES;

    // Pool partagé unique : un seul DuckDB en mémoire, tous les catalogues attachés
    this.sharedPool = null;

    // Map catalogId -> liste des schémas hébergés (le 1er est le schéma par défaut)
    this.schemas = {};
    // Snapshot statique de la liste configurée (référence pour initSchemas)
    this.configuredSchemas = {};
    // Trace des catalogues à allow-list stricte (SCHEMAS explicitement fourni)
    this.explicitlyConfiguredSchemas = new Set();

    // Initialisation automatique
    this.initializeDatabases();
  }

  /**
   * Build the catalog array and create the single shared DuckDB pool.
   * Each entry in config.CATALOGS becomes an ATTACH in the shared DuckDB instance.
   */
  initializeDatabases(): void {
    dbLogger.database('Initializing database manager', {
      defaultCatalog: this.defaultCatalog,
      allowedCatalogs: this.allowedCatalogs,
      allowCrossCatalog: this.allowCrossCatalog,
    });

    // Construction de la liste des catalogues DuckLake à attacher
    const catalogs: CatalogEntry[] = [];

    for (const [catalogId, catalogConfig] of Object.entries(config.CATALOGS)) {
      const type = catalogConfig.TYPE ?? 'file';

      // Liste des schémas du catalogue (SCHEMAS), défaut ['main']
      // SCHEMAS peut arriver sous forme de string JSON depuis une variable d'env
      const resolved = this.resolveSchemas(catalogConfig);
      this.schemas[catalogId] = [...resolved];
      this.configuredSchemas[catalogId] = [...resolved];
      if (catalogConfig.SCHEMAS !== undefined) {
        this.explicitlyConfiguredSchemas.add(catalogId);
      }

      // Résolution du chemin de données (local résolu en absolu, URI distante telle quelle)
      const dataPath = this.resolveDataPath(catalogConfig.DATA_PATH);

      // Catalogue adossé à Postgres : pas de fichier à résoudre/vérifier
      if (type === 'postgres') {
        const pg = catalogConfig.POSTGRES;
        if (!pg?.HOST || !pg?.DATABASE) {
          throw new Error(
            `Postgres catalog '${catalogId}' requires POSTGRES.HOST and POSTGRES.DATABASE.`,
          );
        }
        // Descripteur sans identifiants pour les logs
        dbLogger.database(`Postgres catalog configured for ${catalogId}`, {
          metadata: `postgres://${pg.HOST}:${pg.PORT}/${pg.DATABASE}`,
        });
        catalogs.push({
          alias: catalogId,
          type: 'postgres',
          readOnly: catalogConfig.READ_ONLY ?? true,
          dataPath,
          postgres: {
            host: pg.HOST,
            port: pg.PORT,
            database: pg.DATABASE,
            user: pg.USER,
            password: pg.PASSWORD,
          },
        });
        continue;
      }

      // Catalogue fichier (.ducklake)
      if (!catalogConfig.PATH) {
        throw new Error(`File catalog '${catalogId}' requires a PATH.`);
      }
      // URI distante (s3://, …) telle quelle ; sinon résolution absolue locale
      const catalogPath = isRemoteUri(catalogConfig.PATH)
        ? catalogConfig.PATH
        : resolve(__dirname, '../../', catalogConfig.PATH).replace(/\\/g, '/');

      // Vérification d'existence réservée aux fichiers locaux
      if (!isRemoteUri(catalogPath)) {
        if (!fs.existsSync(catalogPath)) {
          dbLogger.warn(`Catalog file not found for ${catalogId}`, {
            path: catalogPath,
            configPath: catalogConfig.PATH,
          });
        } else {
          const stats = fs.statSync(catalogPath);
          dbLogger.database(`Catalog file found for ${catalogId}`, {
            path: catalogPath,
            size: stats.size,
            modified: stats.mtime,
          });
        }
      }

      catalogs.push({
        alias: catalogId,
        type: 'file',
        path: catalogPath,
        dataPath,
        readOnly: catalogConfig.READ_ONLY ?? true,
      });
    }

    // Validation que le catalogue par défaut est bien dans la liste
    const defaultInCatalogs = catalogs.some((c) => c.alias === this.defaultCatalog);
    if (!defaultInCatalogs) {
      throw new Error(
        `Default catalog '${this.defaultCatalog}' not found in CATALOGS config. ` +
          `Available: ${catalogs.map((c) => c.alias).join(', ')}`,
      );
    }

    // Création du pool partagé unique avec tous les catalogues
    const poolConfig = {
      catalogs,
      maxConnections: config.DATABASE.POOL.MAX_CONNECTIONS,
      acquireTimeout: config.DATABASE.POOL.ACQUIRE_TIMEOUT,
      retryDelay: config.DATABASE.POOL.POOL_RETRY_DELAY,
    };

    dbLogger.database('Creating shared pool', {
      catalogs: catalogs.map((c) => ({
        alias: c.alias,
        type: c.type,
        location:
          c.type === 'postgres'
            ? `postgres://${c.postgres?.host}:${c.postgres?.port}/${c.postgres?.database}`
            : (c.path ?? '').replace(process.cwd(), '.'),
        readOnly: c.readOnly,
      })),
      maxConnections: poolConfig.maxConnections,
    });

    this.sharedPool = new DuckDBPool(poolConfig);

    dbLogger.database('Database manager initialized successfully', {
      attachedCatalogs: catalogs.map((c) => c.alias),
    });
  }

  /**
   * Resolve a catalog DATA_PATH into a form DuckLake accepts.
   * Remote URIs (s3://, gs://, …) are passed through unchanged; local paths are
   * resolved to absolute. A trailing slash is always enforced (DuckLake requirement).
   *
   * @param rawDataPath - DATA_PATH as configured (local path or remote URI).
   * @returns Resolved data path with a guaranteed trailing slash.
   */
  private resolveDataPath(rawDataPath: string): string {
    const base = isRemoteUri(rawDataPath)
      ? rawDataPath
      : resolve(__dirname, '../../', rawDataPath).replace(/\\/g, '/');
    return base.endsWith('/') ? base : base + '/';
  }

  /**
   * Resolve the schema list for a catalog from its SCHEMAS field.
   *
   * SCHEMAS may be a YAML array or a JSON-string (from an env var). When the
   * field is absent, the catalog is assumed to host the single 'main' schema.
   *
   * @param catalogConfig - Per-catalog configuration block.
   * @returns Non-empty deduplicated list of schemas (defaults to ['main']).
   */
  private resolveSchemas(catalogConfig: { SCHEMAS?: string[] | string }): string[] {
    // Liste SCHEMAS absente : on retombe sur le mono-schéma par défaut.
    if (catalogConfig.SCHEMAS === undefined) {
      return ['main'];
    }
    // SCHEMAS peut être un tableau YAML ou une chaîne JSON (variable d'env).
    const raw = catalogConfig.SCHEMAS;
    const list = typeof raw === 'string' ? (JSON.parse(raw) as string[]) : raw;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('CATALOGS.<id>.SCHEMAS must be a non-empty list of schema names.');
    }
    return [...new Set(list)];
  }

  /**
   * Get the shared connection pool.
   * Validates that the requested catalogId is allowed before returning the pool.
   *
   * @param catalogId - Catalog to validate access for (null = default).
   * @returns The shared connection pool.
   * @throws {Error} If catalogId is not in ALLOWED_CATALOGS.
   */
  getPool(catalogId: string | null = null): DuckDBPool {
    const targetCatalog = catalogId ?? this.defaultCatalog;

    if (!this.isValidCatalog(targetCatalog)) {
      throw new Error(
        `Catalog '${targetCatalog}' is not allowed or not configured. ` +
          `Allowed: ${this.allowedCatalogs.join(', ')}`,
      );
    }

    if (!this.sharedPool) {
      throw new Error('Shared pool is not initialized.');
    }

    return this.sharedPool;
  }

  /**
   * Validate if a catalog ID is in the allowed list.
   *
   * @param catalogId - Catalog identifier to validate.
   * @returns True if the catalog is allowed.
   */
  isValidCatalog(catalogId: string): boolean {
    return this.allowedCatalogs.includes(catalogId);
  }

  /**
   * Get list of allowed catalog IDs.
   *
   * @returns List of allowed catalog identifiers.
   */
  getAvailableCatalogs(): string[] {
    return [...this.allowedCatalogs];
  }

  /**
   * Get default catalog ID.
   *
   * @returns Default catalog identifier.
   */
  getDefaultCatalog(): string {
    return this.defaultCatalog;
  }

  /**
   * Get the default DuckLake schema name for a catalog (first in the list).
   *
   * @param catalogId - Catalog identifier.
   * @returns First schema configured for the catalog, or 'main' if none.
   */
  getDefaultSchema(catalogId: string): string {
    const list = this.schemas[catalogId] ?? this.schemas[this.defaultCatalog];
    return list?.[0] ?? 'main';
  }

  /**
   * Get the full list of schemas known for a catalog.
   *
   * @param catalogId - Catalog identifier.
   * @returns Copy of the configured schema list (at least one element).
   */
  getSchemas(catalogId: string): string[] {
    const list = this.schemas[catalogId] ?? this.schemas[this.defaultCatalog] ?? ['main'];
    return [...list];
  }

  /**
   * Check whether a schema is configured for a given catalog.
   *
   * @param catalogId - Catalog identifier.
   * @param schema - Schema name to validate.
   * @returns True when the schema belongs to the catalog's known list.
   */
  isValidSchema(catalogId: string, schema: string): boolean {
    return (this.schemas[catalogId] ?? []).includes(schema);
  }

  /**
   * Check if cross-catalog queries are allowed.
   *
   * @returns True if cross-catalog queries are allowed.
   */
  isCrossCatalogAllowed(): boolean {
    return this.allowCrossCatalog;
  }

  /**
   * Validate and resolve the catalog ID for a GraphQL request.
   * Priority: explicit parameter > HTTP header context > default catalog.
   *
   * @param requestedCatalog - Catalog requested by the client.
   * @param contextCatalog - Catalog from request context (HTTP header).
   * @returns Validated catalog ID to use.
   * @throws {Error} If the resolved catalog is not available.
   */
  validateCatalogRouting(
    requestedCatalog: string | null = null,
    contextCatalog: string | null = null,
  ): string {
    // Priorité : paramètre GraphQL > en-tête HTTP > catalogue par défaut
    // Utilisation de || pour traiter les chaînes vides comme absentes
    const targetCatalog = requestedCatalog || contextCatalog || this.defaultCatalog;

    if (!this.isValidCatalog(targetCatalog)) {
      throw new Error(
        `Catalog '${targetCatalog}' is not available. ` +
          `Available catalogs: ${this.getAvailableCatalogs().join(', ')}`,
      );
    }

    return targetCatalog;
  }

  /**
   * Reload all attached catalogs against their latest state on disk / S3.
   *
   * Rebuilds the shared DuckDB instance so the API picks up data refreshed by an
   * external process (e.g. a nightly DuckLake update) without a pod restart.
   * In-flight requests drain on the old instance; new requests use the fresh
   * catalog. Resolves once the new instance is ready.
   *
   * @throws {Error} If the shared pool is not initialized or the rebuild fails.
   */
  async reloadCatalogs(): Promise<void> {
    if (!this.sharedPool) {
      throw new Error('Shared pool is not initialized.');
    }

    // Logging
    dbLogger.database('Reloading catalogs on shared pool');

    // Re-chargement des catalogues
    await this.sharedPool.reload();

    // Ré-application de la politique d'allow-list contre la nouvelle découverte
    await this.initSchemas();

    // Logging
    dbLogger.database('Catalogs reloaded successfully', {
      attachedCatalogs: this.sharedPool.catalogs.map((c) => c.alias),
    });
  }

  /**
   * Reload a single attached catalog against its latest state on disk / S3.
   *
   * Performs a scoped DETACH + ATTACH of just that catalog on the live shared
   * instance (no full rebuild), so an external process can refresh one catalog
   * without touching the others. Serialized per catalog by the pool.
   *
   * @param catalogId - Alias of the catalog to reattach.
   * @throws {Error} If the catalog is unknown or the pool is not initialized.
   */
  async reloadCatalog(catalogId: string): Promise<void> {
    if (!this.sharedPool) {
      throw new Error('Shared pool is not initialized.');
    }

    // Validation de l'identifiant de catalogue contre l'allowlist
    if (!this.isValidCatalog(catalogId)) {
      throw new Error(
        `Catalog '${catalogId}' is not available. ` +
          `Available catalogs: ${this.getAvailableCatalogs().join(', ')}`,
      );
    }

    dbLogger.database('Reloading single catalog on shared pool', { catalog: catalogId });

    // Ré-attachement ciblé du seul catalogue
    await this.sharedPool.reloadOne(catalogId);

    // Ré-application de la politique d'allow-list (la découverte est portée par
    // une seule requête couvrant tous les catalogues, donc on relance tout)
    await this.initSchemas();

    dbLogger.database('Catalog reloaded successfully', { catalog: catalogId });
  }

  /**
   * Reconcile the per-catalog schema allow-list with what DuckLake actually exposes.
   *
   * Calls {@link DuckDBPool.discoverCatalogSchemas} and applies, per catalog:
   *  - If SCHEMAS was explicitly configured: intersect with the discovered list
   *    (any configured-but-missing schema triggers a warning). Treat the config
   *    as an allow-list — never widen beyond it.
   *  - If SCHEMAS was not configured: adopt the discovered list. Fall back to
   *    ['main'] when the discovery is empty so the API never starts up with an
   *    empty schema list.
   *
   * Idempotent and safe to call repeatedly (start-up, after reloadCatalogs(),
   * after reloadCatalog()). The result is the source of truth for isValidSchema,
   * getSchemas, getDefaultSchema, and the introspection payload.
   *
   * @throws {Error} If the shared pool is not initialized or discovery fails.
   */
  async initSchemas(): Promise<void> {
    if (!this.sharedPool) {
      throw new Error('Shared pool is not initialized.');
    }

    const discovered = await this.sharedPool.discoverCatalogSchemas();

    for (const catalogId of Object.keys(this.configuredSchemas)) {
      const discoveredList = discovered[catalogId] ?? [];

      if (this.explicitlyConfiguredSchemas.has(catalogId)) {
        // Allow-list stricte : intersection (config ∩ découverte), ordre de la config
        const configured = this.configuredSchemas[catalogId];
        const intersection = configured.filter((s) => discoveredList.includes(s));
        const missing = configured.filter((s) => !discoveredList.includes(s));

        if (missing.length > 0) {
          dbLogger.warn(`Configured schemas missing from DuckLake for ${catalogId}`, {
            missing,
            discovered: discoveredList,
          });
        }

        // Fallback : si l'intersection est vide (toute la config est manquante),
        // on conserve la config pour ne pas casser les requêtes existantes,
        // mais on logge un warn explicite.
        if (intersection.length === 0) {
          dbLogger.warn(`No configured schema was discovered for ${catalogId}; keeping config`, {
            configured,
            discovered: discoveredList,
          });
          this.schemas[catalogId] = [...configured];
        } else {
          this.schemas[catalogId] = intersection;
        }
      } else {
        // Pas de SCHEMAS dans la config : on adopte la liste découverte.
        // Fallback à ['main'] si la découverte est vide (catalogue vide / non encore peuplé).
        this.schemas[catalogId] = discoveredList.length > 0 ? [...discoveredList] : ['main'];
      }

      dbLogger.database(`Schemas reconciled for ${catalogId}`, {
        active: this.schemas[catalogId],
        discovered: discoveredList,
        explicit: this.explicitlyConfiguredSchemas.has(catalogId),
      });
    }
  }

  /**
   * Close the shared pool and all its connections.
   */
  async close(): Promise<void> {
    dbLogger.database('Closing shared database pool');

    if (this.sharedPool) {
      try {
        await this.sharedPool.close();
        this.sharedPool = null;
        dbLogger.database('Shared database pool closed successfully');
      } catch (error) {
        dbLogger.error('Error closing shared database pool', error);
        throw error;
      }
    }
  }

  /**
   * Get connection statistics for the shared pool.
   *
   * @returns Statistics for the shared pool and routing configuration.
   */
  getStatistics(): DatabaseStats {
    // Récupération des statistiques du pool partagé si disponible
    const poolStats: PoolStats | null = this.sharedPool
      ? {
          available: this.sharedPool.pool.filter((c) => !c.inUse).length,
          using: this.sharedPool.pool.filter((c) => c.inUse).length,
          total: this.sharedPool.pool.length,
          maxConnections: this.sharedPool.maxConnections,
          attachedCatalogs: (this.sharedPool.catalogs ?? []).map((c) => c.alias),
        }
      : null;

    return {
      sharedPool: poolStats,
      defaultCatalog: this.defaultCatalog,
      allowedCatalogs: this.allowedCatalogs,
      allowCrossCatalog: this.allowCrossCatalog,
    };
  }
}

// Création de l'instance singleton du gestionnaire de base de données
/** Singleton instance of the database manager used throughout the application. */
const databaseManager = new DatabaseManager();

/** Closes all open connections by delegating to {@link DatabaseManager.close}. */
// Fonction de fermeture des connexions avec logging
const closeAllConnections = async (): Promise<void> => {
  await databaseManager.close();
};

// Exportation du gestionnaire et de la fonction de clôture
export { databaseManager, closeAllConnections, DatabaseManager };
