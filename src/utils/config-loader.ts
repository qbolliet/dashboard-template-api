// Importation des modules Node.js et de la bibliothèque YAML
import fs from 'fs';
import yaml from 'yaml';
import path from 'path';
import { fileURLToPath } from 'url';

// Résolution du chemin du fichier courant (équivalent ESM de __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Interfaces de configuration ────────────────────────────────────────────

/** File transport configuration for the logger. */
export interface FileTransportConfig {
  enabled: boolean;
  directory: string;
  filename: string;
  datePattern: string;
  maxSize: string;
  maxFiles: string;
  compress: boolean;
}

/** Console transport configuration for the logger. */
export interface ConsoleTransportConfig {
  enabled: boolean;
}

/** Error file transport configuration for the logger. */
export interface ErrorTransportConfig {
  enabled: boolean;
  directory: string;
  filename: string;
}

/** Rate limiter configuration. */
interface RateLimitConfig {
  /** Set to false to disable enforcement entirely (test configurations). */
  ENABLED?: boolean;
  MAX_REQUESTS: number;
  WINDOW_MS: number;
  MAX_BURST_REQUESTS: number;
  BURST_WINDOW_MS: number;
  SKIP_FAILED_REQUESTS: boolean;
  /** YAML list, or JSON-array / comma-separated string from an env override. */
  TRUSTED_PROXIES: string[] | string;
}

/** Strict rate limiter of the admin endpoints (/api/cache/*, /api/catalog/*). */
interface AdminRateLimitConfig {
  ENABLED?: boolean;
  MAX_REQUESTS?: number;
  WINDOW_MS?: number;
  MAX_BURST_REQUESTS?: number;
  BURST_WINDOW_MS?: number;
}

/** Access to the operational endpoints: /metrics (admin key or allowed IPs). */
interface MetricsAccessConfig {
  /** IPs or CIDR blocks allowed without key; YAML list, or JSON-array / comma-separated string. */
  ALLOWED_IPS?: string[] | string;
}

/**
 * Query complexity analysis configuration (scoring rules in
 * docs-site/toolbox/docs/architecture/security.md).
 */
interface ComplexityConfig {
  /** Maximum score of one operation. */
  MAX_ALLOWED: number;
  /** Maximum number of root fields (aliases included) of one operation. */
  MAX_ROOT_FIELDS: number;
  SCALAR_COST: number;
  OBJECT_COST: number;
  DEPTH_FACTOR: number;
  INTROSPECTION_COST: number;
  /** Cost of one row requested by `limit` (bounded by API.PAGINATION.MAX_LIMIT). */
  ROW_COST: number;
  /** Cost of `Metadata.stats` per column of the enclosing list. */
  STATS_COST_PER_COLUMN: number;
  /** getAggregates: cost of each aggregate. */
  AGGREGATE_COST?: number;
  /** getAggregates: extra cost of each explicit MEDIAN or MODE. */
  HOLISTIC_AGGREGATE_COST?: number;
  /** getAggregates: cost of each group column. */
  GROUP_COLUMN_COST?: number;
  /** Score of a root field missing from ROOT_FIELD_SCORES. */
  DEFAULT_ROOT_FIELD_SCORE: number;
  /** Base score of each root field of the Query type. */
  ROOT_FIELD_SCORES: Record<string, number>;
}

/** Security monitoring configuration. */
interface SecurityMonitoringConfig {
  SLOW_QUERY_THRESHOLD: number;
  LOG_ALL_METRICS: boolean;
}

/** Anti-abuse bounds of the structured filter tree. */
interface FilterTreeConfig {
  MAX_DEPTH: number;
  MAX_CRITERIA: number;
  MAX_IN_VALUES?: number;
  MAX_PATTERN_LENGTH?: number;
}

/** Full security configuration (SECURITY section of the YAML). */
interface SecurityConfig {
  MAX_QUERY_DEPTH: number;
  RATE_LIMIT: RateLimitConfig;
  ADMIN_RATE_LIMIT?: AdminRateLimitConfig;
  METRICS?: MetricsAccessConfig;
  COMPLEXITY: ComplexityConfig;
  MONITORING: SecurityMonitoringConfig;
  FILTER_TREE?: FilterTreeConfig;
}

/** Global security limits (SECURITY_LIMITS section of the YAML). */
interface SecurityLimitsConfig {
  DEFAULT_DEPTH_LIMIT: number;
}

/** Security thresholds exposed in the API section of the YAML. */
interface SecurityThresholdsConfig {
  HSTS_MAX_AGE: number;
  VALIDATION_MAX_LENGTH: number;
  ERROR_TRUNCATION_LENGTH: number;
  QUERY_SNIPPET_LENGTH: number;
}

/** API CORS configuration. */
interface CorsConfig {
  CREDENTIALS: boolean;
  METHODS: string[];
  HEADERS: string[];
  /** Preflight cache duration, in seconds (Access-Control-Max-Age). */
  MAX_AGE: number;
  /**
   * Allowed cross-origin origins. A YAML list in development; a JSON-array
   * string (or comma-separated string) in production, from the CORS_ORIGINS
   * environment variable — see `parseCorsOrigins` in src/security/cors.ts.
   */
  ORIGINS: string[] | string;
}

/** Size limits for incoming HTTP requests. */
interface RequestLimitsConfig {
  MAX_REQUEST_SIZE: string;
  MAX_QUERY_SIZE: number;
}

/** HTTP response compression configuration. */
interface CompressionConfig {
  ENABLED: boolean;
  THRESHOLD: number;
  LEVEL: number;
}

/** GraphQL configuration (introspection and playground). */
interface GraphqlConfig {
  INTROSPECTION: boolean;
  PLAYGROUND: boolean;
}

/** DataLoader configuration (batch size and cache timeouts). */
interface LoadersConfig {
  BATCH_SIZE: number;
  MAX_BATCH_SIZE: number;
  DEFAULT_CACHE_TIMEOUT: number;
  FACT_CACHE_TIMEOUT: number;
  METADATA_CACHE_TIMEOUT: number;
  SELECT_OPTIONS_CACHE_TIMEOUT: number;
}

/** Pagination limits applied to GraphQL queries. */
interface PaginationConfig {
  DEFAULT_LIMIT: number;
  MAX_LIMIT: number;
  MAX_OFFSET: number;
  SELECT_OPTIONS_LIMIT: number;
}

/** Bounds of the select options trees (getSelectOptionsTree). */
interface SelectOptionsConfig {
  /** Hard bound on the node count of a tree; exceeding it is a BAD_USER_INPUT. */
  TREE_MAX_NODES: number;
}

/** Bounds of the aggregate query (getAggregates). */
interface AggregatesConfig {
  /** Maximum number of aggregates of one query; exceeding it is a BAD_USER_INPUT. */
  MAX_AGGREGATES: number;
  /** Maximum number of group columns of one query; exceeding it is a BAD_USER_INPUT. */
  MAX_GROUP_BY: number;
}

/**
 * Guards of the REST export endpoint (GET /api/export).
 *
 * Values may arrive as strings when overridden by environment variables; the
 * export module coerces them with Number().
 */
interface ExportConfig {
  /** Hard ceiling on exported rows, applied as a LIMIT. */
  MAX_ROWS: number | string;
  /** Concurrent exports allowed per client IP. */
  MAX_CONCURRENT_PER_IP: number | string;
  /** Concurrent exports allowed across all clients (each holds a pool connection). */
  MAX_CONCURRENT_TOTAL: number | string;
  /** Budget of one export until its first byte (query and COPY), in milliseconds. */
  TIMEOUT_MS: number | string;
  /** Budget of the transfer, from the first byte to the end, in milliseconds. */
  TRANSFER_TIMEOUT_MS?: number | string;
  /** Directory of the csv/parquet temporary files; empty uses the system tmp dir. */
  TMP_DIR?: string;
  /** Free space, in MB, the tmp volume must keep for a csv/parquet export (0 disables). */
  TMP_MIN_FREE_MB?: number | string;
}

/** Graceful shutdown (SIGTERM / SIGINT). */
interface ShutdownConfig {
  /**
   * Overall budget of the shutdown, in milliseconds: draining of the in-flight
   * requests and exports, then closing of the pool and Redis. Must stay below
   * the pod's terminationGracePeriodSeconds. May arrive as a string.
   */
  TIMEOUT_MS: number | string;
}

/** Redis configuration — reconnection back-off strategy. */
interface CacheRetryStrategyConfig {
  BASE_DELAY: number;
  MAX_DELAY: number;
}

/** Redis configuration — advanced connection options. */
interface CacheRedisOptionsConfig {
  RETRY_STRATEGY: CacheRetryStrategyConfig;
  MAX_RETRIES_PER_REQUEST: number;
  ENABLE_READY_CHECK: boolean;
  CONNECT_TIMEOUT: number;
}

/** Redis configuration — single cluster node. */
interface CacheClusterNodeConfig {
  host: string;
  port: number;
}

/** Redis configuration — cluster mode. */
interface CacheClusterConfig {
  ENABLED: boolean;
  NODES: CacheClusterNodeConfig[];
}

/** Redis client configuration. */
interface CacheRedisConfig {
  HOST: string;
  PORT: number;
  PASSWORD?: string;
  KEY_PREFIX?: string;
  DB?: number;
  OPTIONS: CacheRedisOptionsConfig;
  CLUSTER?: CacheClusterConfig;
}

/** Redis entry TTLs per data type (in seconds). */
interface CacheTTLConfig {
  DEFAULT: number;
  METADATA: number;
  FACTS: number;
  AGGREGATED_FACTS: number;
  SELECT_OPTIONS: number;
  COUNT_QUERIES: number;
}

/** Automatic cache invalidation parameters. */
interface CacheInvalidationConfig {
  GRACE_PERIOD: number;
  AUTO_INVALIDATE: boolean;
  BATCH_SIZE: number;
  TIMEOUT: number;
}

/** HTTP cache configuration (control headers). */
interface CacheHttpConfig {
  PUBLIC_PATHS: string[];
  VARY_BY_HEADERS: string[];
}

/** Complete Redis and HTTP cache configuration. */
interface CacheConfig {
  REDIS: CacheRedisConfig;
  TTL: CacheTTLConfig;
  INVALIDATION: CacheInvalidationConfig;
  HTTP_CACHE: CacheHttpConfig;
}

/** Source type of a DuckLake catalog: a static `.ducklake` file or a Postgres catalog. */
export type CatalogType = 'file' | 'postgres';

/** Postgres connection settings for a DuckLake catalog backed by Postgres. */
export interface PostgresCatalogConfig {
  HOST: string;
  PORT: number;
  DATABASE: string;
  USER: string;
  PASSWORD: string;
}

/** Configuration for an individual DuckLake catalog. */
export interface CatalogConfig {
  /** Catalog source. Defaults to 'file' when omitted (backward compatible). */
  TYPE?: CatalogType;
  /** Path to the `.ducklake` file. Required only when TYPE is 'file'. */
  PATH?: string;
  DATA_PATH: string;
  READ_ONLY: boolean;
  /**
   * Allow-list of the schemas served by the catalog; the first element is the
   * default schema used when a request omits the schema argument. Absent (or
   * an empty value, e.g. `${X_SCHEMAS:-}` with the variable unset) means
   * "serve whatever the catalog holds": the schemas are discovered at attach
   * and reload. The loader turns a JSON-encoded string from an environment
   * variable into a list and drops an empty value, so this is either
   * `undefined` or a non-empty list.
   */
  SCHEMAS?: string[];
  /** Postgres connection settings. Required only when TYPE is 'postgres'. */
  POSTGRES?: PostgresCatalogConfig;
}

/** S3 configuration for remote Parquet file storage. */
export interface S3Config {
  ENABLED: boolean;
  ACCESS_KEY?: string;
  SECRET_KEY?: string;
  REGION?: string;
  ENDPOINT?: string;
}

/** Periodic catalog probe that detects data updates on every replica. */
export interface CatalogFreshnessConfig {
  /** Whether the probe runs at all (the admin reload route works either way). */
  ENABLED: boolean;
  /** Interval between two probes, in milliseconds. */
  INTERVAL_MS: number;
}

/** Complete application configuration loaded from YAML files. */
interface AppConfig {
  ENVIRONMENT: string;
  API: {
    PORT: number;
    DOMAIN?: string;
    CORS: CorsConfig;
    REQUEST_LIMITS: RequestLimitsConfig;
    GRAPHQL: GraphqlConfig;
    COMPRESSION: CompressionConfig;
    TIMEOUTS: {
      FACT_SIMPLE: number;
      FACT_COMPLEX: number;
      AGGREGATED_SIMPLE: number;
      AGGREGATED_COMPLEX: number;
      METADATA: number;
      SELECT_OPTIONS: number;
      CACHE_DEFAULT: number;
    };
    SECURITY_THRESHOLDS: SecurityThresholdsConfig;
    LOADERS: LoadersConfig;
    PAGINATION: PaginationConfig;
    SELECT_OPTIONS?: SelectOptionsConfig;
    AGGREGATES?: AggregatesConfig;
    EXPORT?: ExportConfig;
    SHUTDOWN?: ShutdownConfig;
  };
  DATABASE: {
    POOL: {
      MAX_CONNECTIONS: number;
      ACQUIRE_TIMEOUT: number;
      POOL_RETRY_DELAY: number;
    };
  };
  CATALOG_ROUTING: {
    DEFAULT_CATALOG: string;
    ALLOWED_CATALOGS: string[] | string;
    ALLOW_CROSS_CATALOG_QUERIES: boolean;
  };
  /** Versions de dataset_metadata.schema_version acceptées (JSON en variable d'env). */
  SUPPORTED_SCHEMA_VERSIONS: number[] | string;
  /** Sondage périodique des catalogues (détection des mises à jour sur chaque réplica). */
  CATALOG_FRESHNESS?: CatalogFreshnessConfig;
  S3?: S3Config;
  CACHE: CacheConfig;
  CATALOGS: Record<string, CatalogConfig>;
  SECURITY: SecurityConfig;
  SECURITY_LIMITS: SecurityLimitsConfig;
  LOGGING: {
    LEVEL: string;
    FORMAT: string;
    TRANSPORTS: {
      console: ConsoleTransportConfig;
      file: FileTransportConfig;
      error: ErrorTransportConfig;
    };
    SAMPLING: {
      enabled: boolean;
      rate: number;
    };
    SANITIZATION: {
      fields: string[];
    };
    PERFORMANCE: {
      SLOW_QUERY_THRESHOLD: number;
    };
  };
}

/** Generic intermediate object used during merging and resolution. */
type ConfigRecord = Record<string, unknown>;

// ─── Classe de chargement de la configuration ────────────────────────────────

/**
 * Loads, merges, and validates YAML configuration files.
 *
 * Supports environment-variable substitution using the `${VAR:-default}` syntax
 * and environment-specific overrides for development/production environments.
 */
export class ConfigLoader {
  private configDir: string;
  private config: AppConfig | null;

  // Initialisation des chemins et de l'état interne
  constructor() {
    this.configDir = path.resolve(__dirname, '../../config');
    this.config = null;
  }

  /**
   * Loads all YAML configuration files and returns the merged config.
   *
   * Subsequent calls return the cached result without re-reading files.
   *
   * @returns The fully merged and validated application configuration.
   * @throws {Error} When a required field is missing or the environment is invalid.
   */
  // Chargement et fusion de tous les fichiers de configuration YAML
  loadConfig(): AppConfig {
    if (this.config) return this.config;

    // Liste des fichiers de configuration à fusionner dans l'ordre
    const configFiles = [
      'main.yaml',
      'database.yaml',
      'api.yaml',
      'cache.yaml',
      'security.yaml',
      'logging.yaml',
    ];

    let merged: ConfigRecord = {};

    // Lecture et fusion successive des fichiers YAML
    configFiles.forEach((file) => {
      const filePath = path.join(this.configDir, file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(content) as ConfigRecord;
        merged = this.mergeDeep(merged, parsed);
      }
    });

    // Substitution des variables d'environnement
    merged = this.resolveEnvVariables(merged);

    // Application des surcharges spécifiques à l'environnement
    merged = this.applyEnvironmentSpecific(merged);

    // Conversion automatique des valeurs numériques et booléennes
    merged = this.convertNumericValues(merged);

    // Listes de schémas (vide = découverte) et catalogues autorisés (défaut = CATALOGS)
    merged = this.normalizeCatalogSchemas(merged);
    merged = this.resolveAllowedCatalogs(merged);

    // Validation de l'environnement déclaré
    this.validateEnvironment(merged);

    // Validation des champs obligatoires
    this.validateRequiredFields(merged);

    this.config = merged as unknown as AppConfig;
    return this.config;
  }

  /**
   * Performs a deep merge of two plain objects.
   *
   * @param target - Base object to merge into.
   * @param source - Object whose properties override or extend the target.
   * @returns A new object combining both inputs recursively.
   */
  // Fusion profonde de deux objets simples (non destructive)
  private mergeDeep(target: ConfigRecord, source: ConfigRecord): ConfigRecord {
    const output: ConfigRecord = { ...target };

    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (this.isObject(source[key] as ConfigRecord)) {
          if (!(key in target)) {
            output[key] = source[key];
          } else {
            output[key] = this.mergeDeep(target[key] as ConfigRecord, source[key] as ConfigRecord);
          }
        } else {
          output[key] = source[key];
        }
      });
    }

    return output;
  }

  /**
   * Checks whether a value is a plain (non-array) object.
   *
   * @param item - Value to inspect.
   * @returns True when the value is a non-null, non-array object.
   */
  // Vérification qu'une valeur est un objet simple (hors tableaux)
  private isObject(item: unknown): item is ConfigRecord {
    return Boolean(item && typeof item === 'object' && !Array.isArray(item));
  }

  /**
   * Resolves `${VAR:-default}` placeholders against process environment variables.
   *
   * @param obj - Configuration value (string, array, or object) to process recursively.
   * @returns The same structure with all placeholders replaced.
   */
  // Résolution des variables d'environnement au format ${VAR:-default}
  private resolveEnvVariables(obj: unknown): ConfigRecord {
    const envPattern = /\$\{([^}]+)\}/g;

    const resolve = (item: unknown): unknown => {
      if (typeof item === 'string') {
        return item.replace(envPattern, (_match, envVar: string) => {
          const [varName, defaultValue] = envVar.split(':-');
          return process.env[varName] ?? defaultValue ?? _match;
        });
      } else if (Array.isArray(item)) {
        return item.map(resolve);
      } else if (this.isObject(item)) {
        const resolved: ConfigRecord = {};
        Object.keys(item).forEach((key) => {
          resolved[key] = resolve(item[key]);
        });
        return resolved;
      }
      return item;
    };

    return resolve(obj) as ConfigRecord;
  }

  /**
   * Selects and merges the environment-specific section of the config.
   *
   * When an object has `development` or `production` keys, the current
   * environment's values are inlined, replacing the branched structure.
   *
   * @param config - Raw configuration record after env-variable resolution.
   * @returns Configuration with environment branches flattened.
   */
  // Aplatissement des branches d'environnement (development / production)
  private applyEnvironmentSpecific(config: ConfigRecord): ConfigRecord {
    const env = (config['ENVIRONMENT'] as string) || 'development';

    const applyEnv = (obj: unknown): unknown => {
      if (!this.isObject(obj)) return obj;

      // Détection d'un objet contenant des clés d'environnement
      if (obj['development'] || obj['production']) {
        // Fusion avec la section commune si présente (clé `common`)
        if (obj['common']) {
          const envSpecific = (obj[env] ?? obj['development'] ?? {}) as ConfigRecord;
          const result: ConfigRecord = { ...(obj['common'] as ConfigRecord) };

          // Fusion des tableaux plutôt que remplacement
          Object.keys(envSpecific).forEach((key) => {
            if (Array.isArray(result[key]) && Array.isArray(envSpecific[key])) {
              result[key] = [...(result[key] as unknown[]), ...(envSpecific[key] as unknown[])];
            } else {
              result[key] = envSpecific[key];
            }
          });

          return result;
        }

        // Sélection directe de la branche d'environnement
        return (obj[env] ?? obj['development'] ?? {}) as ConfigRecord;
      }

      // Application récursive sur les objets imbriqués
      const result: ConfigRecord = {};
      Object.keys(obj).forEach((key) => {
        result[key] = applyEnv(obj[key]);
      });
      return result;
    };

    return applyEnv(config) as ConfigRecord;
  }

  /**
   * Converts string representations of numbers and booleans to native types.
   *
   * @param obj - Configuration value to process recursively.
   * @returns The same structure with strings coerced where applicable.
   */
  // Conversion automatique des chaînes numériques et booléennes vers leurs types natifs
  private convertNumericValues(obj: unknown): ConfigRecord {
    const convert = (item: unknown): unknown => {
      if (typeof item === 'string') {
        // Entier
        if (/^-?\d+$/.test(item.trim())) {
          return parseInt(item.trim(), 10);
        }
        // Décimal
        if (/^-?\d*\.\d+$/.test(item.trim())) {
          return parseFloat(item.trim());
        }
        // Booléen vrai
        if (item.trim().toLowerCase() === 'true') {
          return true;
        }
        // Booléen faux
        if (item.trim().toLowerCase() === 'false') {
          return false;
        }
        return item;
      } else if (Array.isArray(item)) {
        return item.map(convert);
      } else if (this.isObject(item)) {
        const converted: ConfigRecord = {};
        Object.keys(item).forEach((key) => {
          converted[key] = convert(item[key]);
        });
        return converted;
      }
      return item;
    };

    return convert(obj) as ConfigRecord;
  }

  /**
   * Parses a list given as a YAML array or as a JSON-encoded string.
   *
   * @param raw - Value read from the configuration.
   * @param label - Setting name, quoted in the error message.
   * @returns The list, or null when the value is absent or empty (null, undefined,
   *   blank string, empty array).
   * @throws {Error} When the value is neither a list of non-empty strings nor a
   *   JSON string encoding one.
   */
  // Liste fournie en YAML ou en JSON (variable d'env) ; « absent ou vide » vaut null
  private parseStringList(raw: unknown, label: string): string[] | null {
    if (raw === undefined || raw === null) return null;

    let list: unknown = raw;
    if (typeof raw === 'string') {
      if (raw.trim() === '') return null;
      try {
        list = JSON.parse(raw);
      } catch {
        throw new Error(`${label} must be a JSON list of strings, e.g. ["main"]; got: ${raw}`);
      }
    }

    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item === '')) {
      throw new Error(`${label} must be a list of non-empty strings.`);
    }
    return list.length === 0 ? null : [...new Set(list as string[])];
  }

  /**
   * Normalizes `CATALOGS.<id>.SCHEMAS`: a list, or absent.
   *
   * A catalog whose SCHEMAS is absent, null, blank or `[]` serves every schema
   * it holds (discovered at attach). The default value of `config/database.yaml`
   * is the empty string, so "no variable set" reaches this point as `''` and
   * must not be read as an (invalid) empty allow-list.
   *
   * @param config - Configuration record after env resolution and coercion.
   * @returns The configuration, each catalog with a list SCHEMAS or none.
   * @throws {Error} When a SCHEMAS value is malformed.
   */
  // Normalisation de SCHEMAS : liste non vide ou clé supprimée (découverte)
  private normalizeCatalogSchemas(config: ConfigRecord): ConfigRecord {
    const catalogs = config['CATALOGS'];
    if (!this.isObject(catalogs)) return config;

    const normalized: ConfigRecord = {};
    for (const [id, catalog] of Object.entries(catalogs)) {
      if (!this.isObject(catalog) || !('SCHEMAS' in catalog)) {
        normalized[id] = catalog;
        continue;
      }
      const { SCHEMAS: raw, ...rest } = catalog;
      const list = this.parseStringList(raw, `CATALOGS.${id}.SCHEMAS`);
      normalized[id] = list ? { ...rest, SCHEMAS: list } : rest;
    }
    return { ...config, CATALOGS: normalized };
  }

  /**
   * Fills `CATALOG_ROUTING.ALLOWED_CATALOGS` with the CATALOGS keys when unset.
   *
   * Listing the catalogs twice (in CATALOGS and in ALLOWED_CATALOGS) invites
   * drift; without an explicit list every configured catalog is allowed, and an
   * explicit list narrows it. A JSON-encoded string is parsed into a list.
   *
   * @param config - Configuration record after env resolution and coercion.
   * @returns The configuration with a list ALLOWED_CATALOGS (left absent when
   *   no catalog is configured, which validation reports).
   * @throws {Error} When ALLOWED_CATALOGS is malformed.
   */
  // Défaut de ALLOWED_CATALOGS : les clés de CATALOGS
  private resolveAllowedCatalogs(config: ConfigRecord): ConfigRecord {
    const routing = config['CATALOG_ROUTING'];
    if (!this.isObject(routing)) return config;

    const explicit = this.parseStringList(
      routing['ALLOWED_CATALOGS'],
      'CATALOG_ROUTING.ALLOWED_CATALOGS',
    );
    const catalogs = config['CATALOGS'];
    const allowed = explicit ?? (this.isObject(catalogs) ? Object.keys(catalogs) : []);
    if (allowed.length === 0) return config;

    return { ...config, CATALOG_ROUTING: { ...routing, ALLOWED_CATALOGS: allowed } };
  }

  /**
   * Validates that the ENVIRONMENT field holds a recognised value.
   *
   * @param config - Configuration record after all transformations.
   * @throws {Error} When ENVIRONMENT is not one of the allowed values.
   */
  // Vérification de la validité de la valeur d'environnement
  private validateEnvironment(config: ConfigRecord): void {
    const validEnvironments = ['development', 'production'];
    const environment = config['ENVIRONMENT'] as string;

    if (!validEnvironments.includes(environment)) {
      throw new Error(
        `Invalid environment: ${environment}. Must be one of: ${validEnvironments.join(', ')}`,
      );
    }
  }

  /**
   * Validates that all required configuration fields are present and non-empty.
   *
   * @param config - Configuration record after all transformations.
   * @throws {Error} When one or more required fields are absent.
   */
  // Validation de la présence des champs obligatoires au démarrage
  private validateRequiredFields(config: ConfigRecord): void {
    const required: { path: string; label: string }[] = [
      { path: 'API.PORT', label: 'PORT' },
      { path: 'CATALOG_ROUTING.DEFAULT_CATALOG', label: 'DEFAULT_CATALOG' },
      { path: 'CATALOG_ROUTING.ALLOWED_CATALOGS', label: 'ALLOWED_CATALOGS' },
      { path: 'DATABASE.POOL.MAX_CONNECTIONS', label: 'DB_MAX_CONNECTIONS' },
      { path: 'SECURITY.RATE_LIMIT.MAX_REQUESTS', label: 'RATE_LIMIT_MAX_REQUESTS' },
    ];

    const missing: string[] = [];

    for (const { path, label } of required) {
      const value = path
        .split('.')
        .reduce<unknown>((obj, key) => (obj as ConfigRecord)?.[key], config);

      if (value === undefined || value === null || value === '') {
        missing.push(label);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing required configuration: ${missing.join(', ')}. ` +
          `Check your environment variables or config files.`,
      );
    }

    // Présence d'au moins un catalogue configuré
    const catalogs = config['CATALOGS'] as Record<string, unknown> | undefined;
    if (!catalogs || Object.keys(catalogs).length === 0) {
      throw new Error(
        'No catalogs configured. Add at least one entry to CATALOGS in database.yaml.',
      );
    }
  }

  /**
   * Retrieves a configuration value by dot-separated path.
   *
   * @param dotPath - Dot-separated key path, e.g. "API.PORT".
   * @param defaultValue - Value returned when the path does not exist.
   * @returns The value at the given path, or defaultValue when absent.
   */
  // Accès à une valeur de configuration par chemin en pointillés
  get(dotPath: string, defaultValue: unknown = null): unknown {
    // Chargement à la demande si la configuration n'existe pas encore
    if (!this.config) this.loadConfig();

    return (
      dotPath
        .split('.')
        .reduce<unknown>(
          (obj, key) =>
            obj !== null && obj !== undefined ? (obj as ConfigRecord)[key] : defaultValue,
          this.config,
        ) ?? defaultValue
    );
  }
}

// Instanciation du loader et chargement immédiat de la configuration
/** Singleton {@link ConfigLoader} instance for the application. */
const configLoader = new ConfigLoader();
/** Fully resolved application configuration, loaded at module initialisation. */
const config = configLoader.loadConfig();

export { configLoader, config };
export type {
  AppConfig,
  ConfigRecord,
  LoadersConfig,
  PaginationConfig,
  CacheConfig,
  CacheRedisConfig,
  CacheRedisOptionsConfig,
  CacheRetryStrategyConfig,
  CacheClusterConfig,
  CacheClusterNodeConfig,
  CacheTTLConfig,
  CacheInvalidationConfig,
  CacheHttpConfig,
  SecurityConfig,
  SecurityLimitsConfig,
  SecurityThresholdsConfig,
  RateLimitConfig,
  AdminRateLimitConfig,
  ComplexityConfig,
  SecurityMonitoringConfig,
  CorsConfig,
  RequestLimitsConfig,
  CompressionConfig,
  GraphqlConfig,
  ExportConfig,
  ShutdownConfig,
  MetricsAccessConfig,
};
