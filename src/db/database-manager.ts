// Importation des modules nécessaires pour la gestion des bases de données
import { GraphQLError } from 'graphql';
import { DuckDBPool, type CatalogEntry, type PoolStats } from './pool.js';
import { dirname, resolve } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from '../utils/config-loader.js';
import { qualifiedTable } from '../utils/identifiers.js';
import { createContextLogger } from '../utils/logger.js';
import { recordSchemaVersion, resetSchemaVersions } from './schema-version.js';

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

/** Full statistics snapshot for the database manager. */
export interface DatabaseStats {
  sharedPool: PoolStats | null;
  defaultCatalog: string;
  allowedCatalogs: string[];
  allowCrossCatalog: boolean;
}

/**
 * Data version of one catalog/schema, as served by the live instance.
 *
 * Read from `dataset_metadata.updated_at`, which the writer stamps inside the
 * transaction of every write: it changes exactly when the data does.
 */
export interface DataVersion {
  /** `epoch_us(updated_at)` as a digit string, or {@link NO_DATA_VERSION}. */
  version: string;
  /** `updated_at` as ISO 8601 UTC, or null when unreadable. */
  updatedAt: string | null;
}

/**
 * Explicit settings replacing the configuration, so that several independent
 * managers (several "API instances") can live in one process — used by tests.
 */
export interface DatabaseManagerOptions {
  /** Catalog entries to attach, used as is (no path resolution). */
  catalogs: CatalogEntry[];
  /** Schema allow-list per catalog; a catalog without entry adopts the discovery. */
  schemas?: Record<string, string[]>;
  /** Default catalog (defaults to the first entry). */
  defaultCatalog?: string;
  /** Allowed catalogs (defaults to every entry). */
  allowedCatalogs?: string[];
  /** Whether cross-catalog queries are allowed (defaults to false). */
  allowCrossCatalog?: boolean;
}

/** Version segment used when a schema has no readable `updated_at`. */
export const NO_DATA_VERSION = 'none';

// Lecture du marqueur de version : updated_at en microsecondes (chiffres seuls,
// sans « : » qui casserait les motifs de clés Redis) et en ISO pour les métriques
export const DATA_VERSION_SELECT =
  'schema_version, ' +
  'CAST(epoch_us(updated_at) AS VARCHAR) AS data_version, ' +
  "strftime(updated_at, '%Y-%m-%dT%H:%M:%S.%fZ') AS updated_at_iso";

/**
 * Decodes the version columns of a `dataset_metadata` row.
 *
 * @param row - Row read with {@link DATA_VERSION_SELECT}, or undefined when the table is empty.
 * @returns The data version (NO_DATA_VERSION when `updated_at` is NULL or the row missing).
 */
export const toDataVersion = (row: Record<string, unknown> | undefined): DataVersion => {
  const raw = row?.['data_version'];
  const iso = row?.['updated_at_iso'];
  return {
    version: raw === null || raw === undefined ? NO_DATA_VERSION : String(raw),
    updatedAt: iso === null || iso === undefined ? null : String(iso),
  };
};

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
  // Version des données servie par l'instance vivante, par "catalogue.schéma".
  // Remplacée d'un bloc après chaque (re)lecture : jamais d'état partiel.
  private dataVersions: Map<string, DataVersion>;
  // Réglages explicites remplaçant la configuration (null = configuration)
  private readonly options: DatabaseManagerOptions | null;

  /**
   * @param options - Explicit settings replacing the configuration; omit to read
   *   `config.CATALOGS` / `config.CATALOG_ROUTING` (the application singleton).
   */
  constructor(options: DatabaseManagerOptions | null = null) {
    this.options = options;

    if (options) {
      // Réglages explicites : catalogues fournis tels quels
      const aliases = options.catalogs.map((c) => c.alias);
      this.defaultCatalog = options.defaultCatalog ?? aliases[0] ?? '';
      this.allowedCatalogs = options.allowedCatalogs ?? aliases;
      this.allowCrossCatalog = options.allowCrossCatalog ?? false;
    } else {
      // Configuration du routage des catalogues depuis le fichier de config
      this.defaultCatalog = config.CATALOG_ROUTING.DEFAULT_CATALOG;

      // ALLOWED_CATALOGS peut être une string JSON ou un tableau selon le config-loader
      const rawAllowed = config.CATALOG_ROUTING.ALLOWED_CATALOGS;
      this.allowedCatalogs =
        typeof rawAllowed === 'string' ? (JSON.parse(rawAllowed) as string[]) : rawAllowed;

      this.allowCrossCatalog = config.CATALOG_ROUTING.ALLOW_CROSS_CATALOG_QUERIES;
    }

    // Pool partagé unique : un seul DuckDB en mémoire, tous les catalogues attachés
    this.sharedPool = null;

    // Map catalogId -> liste des schémas hébergés (le 1er est le schéma par défaut)
    this.schemas = {};
    // Snapshot statique de la liste configurée (référence pour initSchemas)
    this.configuredSchemas = {};
    // Trace des catalogues à allow-list stricte (SCHEMAS explicitement fourni)
    this.explicitlyConfiguredSchemas = new Set();
    // Aucune version connue avant la première lecture (initSchemas)
    this.dataVersions = new Map();

    // Initialisation automatique
    this.initializeDatabases();
  }

  /**
   * Build the catalog entries from explicit options, recording their schema lists.
   *
   * @param options - Explicit settings given to the constructor.
   * @returns The catalog entries, unchanged.
   */
  private catalogsFromOptions(options: DatabaseManagerOptions): CatalogEntry[] {
    for (const catalog of options.catalogs) {
      const listed = options.schemas?.[catalog.alias];
      this.schemas[catalog.alias] = listed ? [...listed] : ['main'];
      this.configuredSchemas[catalog.alias] = listed ? [...listed] : ['main'];
      if (listed) {
        this.explicitlyConfiguredSchemas.add(catalog.alias);
      }
    }
    return [...options.catalogs];
  }

  /**
   * Build the catalog array and create the single shared DuckDB pool.
   * Each entry in config.CATALOGS (or in the explicit options) becomes an ATTACH
   * in the shared DuckDB instance.
   */
  initializeDatabases(): void {
    dbLogger.database('Initializing database manager', {
      defaultCatalog: this.defaultCatalog,
      allowedCatalogs: this.allowedCatalogs,
      allowCrossCatalog: this.allowCrossCatalog,
    });

    // Construction de la liste des catalogues DuckLake à attacher
    const catalogs: CatalogEntry[] = this.options ? this.catalogsFromOptions(this.options) : [];
    const configuredCatalogs = this.options ? {} : config.CATALOGS;

    for (const [catalogId, catalogConfig] of Object.entries(configuredCatalogs)) {
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
   * Priority: explicit parameter > fallback parameter > default catalog.
   *
   * Catalog targeting is argument-only (no HTTP header is ever consulted);
   * `fallbackCatalog` exists for callers resolving a fallback other than the
   * default (most callers pass only `requestedCatalog`).
   *
   * @param requestedCatalog - Catalog requested by the client.
   * @param fallbackCatalog - Catalog to use when none was requested, before the default.
   * @returns Validated catalog ID to use.
   * @throws {GraphQLError} BAD_USER_INPUT if the resolved catalog is not available.
   */
  validateCatalogRouting(
    requestedCatalog: string | null = null,
    fallbackCatalog: string | null = null,
  ): string {
    // Priorité : paramètre explicite > paramètre de repli > catalogue par défaut
    const targetCatalog = requestedCatalog || fallbackCatalog || this.defaultCatalog;

    if (!this.isValidCatalog(targetCatalog)) {
      // Erreur de saisie du client : message exposé tel quel, même en production
      throw new GraphQLError(
        `Catalog '${targetCatalog}' is not available. ` +
          `Available catalogs: ${this.getAvailableCatalogs().join(', ')}`,
        { extensions: { code: 'BAD_USER_INPUT' } },
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
   * catalog. Resolves once the old instance is closed and the data versions
   * (hence the cache namespaces) have been re-read on the new one.
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

    // Attente de la fermeture de l'ancienne instance AVANT de relire les
    // versions : une fois la version montée, plus aucune connexion ne lit
    // l'ancien état, donc aucune donnée périmée sous une clé de nouvelle version
    await this.sharedPool.awaitDrain();

    // Ré-application de la politique d'allow-list contre la nouvelle découverte
    // (relit aussi les versions de données servies)
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

    // Sondage de la version de chaque schéma actif, une fois par attach/reload
    await this.probeSchemaVersions();
  }

  /**
   * Probes `dataset_metadata.schema_version` for every active schema.
   *
   * Runs once per attach/reload and caches its verdict in db/schema-version.ts,
   * so no query path ever pays for this check. An unsupported or unreadable
   * schema is warned about here and rejected later, when a query targets it —
   * start-up is never blocked, because the other schemas remain usable.
   */
  // Sondage des versions : un seul passage, verdict mis en cache
  private async probeSchemaVersions(): Promise<void> {
    if (!this.sharedPool) return;

    resetSchemaVersions();

    // Nouvelle table des versions servies, assignée d'un bloc à la fin
    const dataVersions = new Map<string, DataVersion>();

    const connection = await this.sharedPool.acquire();
    try {
      for (const [catalogId, schemaList] of Object.entries(this.schemas)) {
        for (const schema of schemaList) {
          let version: number | null = null;
          let dataVersion: DataVersion = { version: NO_DATA_VERSION, updatedAt: null };
          try {
            // Une seule lecture pour la version du format et celle des données
            const rows = await connection.all(
              `SELECT ${DATA_VERSION_SELECT} FROM ${qualifiedTable(catalogId, schema, 'dataset_metadata')} LIMIT 1`,
            );
            const raw = rows[0]?.schema_version;
            // Une table présente mais vide vaut une table absente (spec §2.3 :
            // exactement une ligne par schéma).
            version = raw === null || raw === undefined ? null : Number(raw);
            dataVersion = toDataVersion(rows[0]);
          } catch {
            // Table dataset_metadata absente : catalogue à l'ancien format
            version = null;
          }
          recordSchemaVersion(catalogId, schema, version);
          dataVersions.set(`${catalogId}.${schema}`, dataVersion);
        }
      }
    } finally {
      this.sharedPool.release(connection);
    }

    // Bascule atomique : les clés de cache suivantes portent la nouvelle version
    this.dataVersions = dataVersions;
  }

  /**
   * Returns the data version served for a catalog/schema.
   *
   * It is the `updated_at` marker read on the live instance at the last
   * (re)attach, and it enters every Redis key of that schema
   * (`<type>:<catalog>:<schema>@<version>:…`): once it changes, entries
   * computed on older data are no longer reachable.
   *
   * @param catalogId - Catalog alias.
   * @param schema - Schema name within the catalog.
   * @returns The version segment, or NO_DATA_VERSION when never read.
   */
  getDataVersion(catalogId: string, schema: string): string {
    return this.dataVersions.get(`${catalogId}.${schema}`)?.version ?? NO_DATA_VERSION;
  }

  /**
   * Returns every data version served, for diagnostics and metrics.
   *
   * @returns Nested record catalog → schema → data version.
   */
  getDataVersions(): Record<string, Record<string, DataVersion>> {
    const result: Record<string, Record<string, DataVersion>> = {};
    for (const [catalogId, schemaList] of Object.entries(this.schemas)) {
      result[catalogId] = {};
      for (const schema of schemaList) {
        result[catalogId][schema] = this.dataVersions.get(`${catalogId}.${schema}`) ?? {
          version: NO_DATA_VERSION,
          updatedAt: null,
        };
      }
    }
    return result;
  }

  /**
   * Returns the catalog entries attached to the shared pool.
   *
   * @returns Copy of the catalog entries (empty when the pool is closed).
   */
  getCatalogEntries(): CatalogEntry[] {
    return [...(this.sharedPool?.catalogs ?? [])];
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
    // Statistiques du pool partagé (occupation, file, attentes) si disponible
    return {
      sharedPool: this.sharedPool ? this.sharedPool.getStats() : null,
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
