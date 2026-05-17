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

/** Raw entry for a security pattern (block-list). */
interface SecurityPatternEntry {
  pattern: string;
  message: string;
  flags?: string;
}

/** Rate limiter configuration. */
interface RateLimitConfig {
  MAX_REQUESTS: number;
  WINDOW_MS: number;
  MAX_BURST_REQUESTS: number;
  BURST_WINDOW_MS: number;
  SKIP_FAILED_REQUESTS: boolean;
  TRUSTED_PROXIES: string[];
}

/** Query complexity analysis configuration. */
interface ComplexityConfig {
  MAX_ALLOWED: number;
  SCALAR_COST: number;
  OBJECT_COST: number;
  LIST_FACTOR: number;
  DEPTH_FACTOR: number;
  INTROSPECTION_COST: number;
  CUSTOM_SCORES: Record<string, number>;
}

/** User input sanitization configuration. */
interface SanitizationConfig {
  ENABLE_XSS: boolean;
  ENABLE_SQL: boolean;
  MAX_STRING_LENGTH: number;
  ALLOWED_TAGS: string[];
  CUSTOM_SANITIZERS: Record<string, (value: unknown) => unknown>;
}

/** Security monitoring configuration. */
interface SecurityMonitoringConfig {
  SLOW_QUERY_THRESHOLD: number;
  LOG_ALL_METRICS: boolean;
}

/** Full security configuration (SECURITY section of the YAML). */
interface SecurityConfig {
  MAX_QUERY_DEPTH: number;
  RATE_LIMIT: RateLimitConfig;
  COMPLEXITY: ComplexityConfig;
  SANITIZATION: SanitizationConfig;
  MONITORING: SecurityMonitoringConfig;
}

/** Global security limits (SECURITY_LIMITS section of the YAML). */
interface SecurityLimitsConfig {
  DEFAULT_DEPTH_LIMIT: number;
  MAX_INPUT_LENGTH: number;
  COMPLEXITY_LIST_FACTOR: number;
  COMPLEXITY_DEPTH_FACTOR: number;
  COMPLEXITY_CALCULATION_FACTOR: number;
}

/** Request validation patterns (SECURITY_PATTERNS section of the YAML). */
interface SecurityPatternsConfig {
  blocked: SecurityPatternEntry[];
  allowed: string[];
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
  ORIGINS: string[];
}

/** Size limits for incoming HTTP requests. */
interface RequestLimitsConfig {
  MAX_REQUEST_SIZE: string;
  MAX_FIELD_SIZE: number;
  MAX_FIELDS: number;
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
  DIMENSION_CACHE_TIMEOUT: number;
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
  DIMENSIONS: number;
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

/** Configuration for an individual DuckLake catalog. */
export interface CatalogConfig {
  PATH: string;
  DATA_PATH: string;
  READ_ONLY: boolean;
  SCHEMA?: string;
}

/** S3 configuration for remote Parquet file storage. */
export interface S3Config {
  ENABLED: boolean;
  ACCESS_KEY?: string;
  SECRET_KEY?: string;
  REGION?: string;
  ENDPOINT?: string;
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
      DIMENSION: number;
      METADATA: number;
      SELECT_OPTIONS: number;
      CACHE_DEFAULT: number;
    };
    SECURITY_THRESHOLDS: SecurityThresholdsConfig;
    LOADERS: LoadersConfig;
    PAGINATION: PaginationConfig;
  };
  DATABASE: {
    POOL: {
      MAX_CONNECTIONS: number;
      ACQUIRE_TIMEOUT: number;
      POOL_RETRY_DELAY: number;
    };
  };
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: string;
    ALLOWED_DATABASES: string[] | string;
    ALLOW_CROSS_DATABASE_QUERIES: boolean;
  };
  S3?: S3Config;
  CACHE: CacheConfig;
  CATALOGS: Record<string, CatalogConfig>;
  SECURITY: SecurityConfig;
  SECURITY_LIMITS: SecurityLimitsConfig;
  SECURITY_PATTERNS: SecurityPatternsConfig;
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
      'security-patterns.yaml',
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
        // Fusion avec la section commune si présente (ex. SECURITY_PATTERNS)
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
      { path: 'DATABASE_ROUTING.DEFAULT_DATABASE', label: 'DEFAULT_DATABASE' },
      { path: 'DATABASE_ROUTING.ALLOWED_DATABASES', label: 'ALLOWED_DATABASES' },
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
  SecurityPatternsConfig,
  SecurityPatternEntry,
  SecurityThresholdsConfig,
  RateLimitConfig,
  ComplexityConfig,
  SanitizationConfig,
  SecurityMonitoringConfig,
  CorsConfig,
  RequestLimitsConfig,
  CompressionConfig,
  GraphqlConfig,
};
