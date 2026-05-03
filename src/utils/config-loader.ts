// Importation des modules Node.js et de la bibliothèque YAML
import fs from 'fs';
import yaml from 'yaml';
import path from 'path';
import { fileURLToPath } from 'url';

// Résolution du chemin du fichier courant (équivalent ESM de __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Interfaces de configuration ────────────────────────────────────────────

/** Configuration du transport fichier pour le logger. */
interface FileTransportConfig {
    enabled: boolean;
    directory: string;
    filename: string;
    datePattern: string;
    maxSize: string;
    maxFiles: string;
    compress: boolean;
}

/** Configuration du transport console pour le logger. */
interface ConsoleTransportConfig {
    enabled: boolean;
}

/** Configuration du transport fichier d'erreurs pour le logger. */
interface ErrorTransportConfig {
    enabled: boolean;
    directory: string;
    filename: string;
}

/** Configuration complète de l'application chargée depuis les fichiers YAML. */
interface AppConfig {
    ENVIRONMENT: string;
    API: {
        PORT: number;
        TIMEOUTS: {
            CACHE_DEFAULT: number;
        };
    };
    DATABASE: {
        POOL: {
            MAX_CONNECTIONS: number;
        };
    };
    DATABASE_ROUTING: {
        DEFAULT_DATABASE: string;
        ALLOWED_DATABASES: string[];
    };
    CATALOGS: Record<string, unknown>;
    SECURITY: {
        RATE_LIMIT: {
            MAX_REQUESTS: number;
        };
    };
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

/** Objet intermédiaire générique utilisé lors de la fusion et de la résolution. */
type ConfigRecord = Record<string, unknown>;

// ─── Classe de chargement de la configuration ────────────────────────────────

/**
 * Loads, merges, and validates YAML configuration files.
 *
 * Supports environment-variable substitution using the `${VAR:-default}` syntax
 * and environment-specific overrides for development/production environments.
 */
class ConfigLoader {
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
     * Returns:
     *     The fully merged and validated application configuration.
     *
     * Raises:
     *     Error: When a required field is missing or the environment is invalid.
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
            'logging.yaml'
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
     * Args:
     *     target: Base object to merge into.
     *     source: Object whose properties override or extend the target.
     *
     * Returns:
     *     A new object combining both inputs recursively.
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
                        output[key] = this.mergeDeep(
                            target[key] as ConfigRecord,
                            source[key] as ConfigRecord
                        );
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
     * Args:
     *     item: Value to inspect.
     *
     * Returns:
     *     True when the value is a non-null, non-array object.
     */
    // Vérification qu'une valeur est un objet simple (hors tableaux)
    private isObject(item: unknown): item is ConfigRecord {
        return Boolean(item && typeof item === 'object' && !Array.isArray(item));
    }

    /**
     * Resolves `${VAR:-default}` placeholders against process environment variables.
     *
     * Args:
     *     obj: Configuration value (string, array, or object) to process recursively.
     *
     * Returns:
     *     The same structure with all placeholders replaced.
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
     * Args:
     *     config: Raw configuration record after env-variable resolution.
     *
     * Returns:
     *     Configuration with environment branches flattened.
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
                            result[key] = [
                                ...(result[key] as unknown[]),
                                ...(envSpecific[key] as unknown[])
                            ];
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
     * Args:
     *     obj: Configuration value to process recursively.
     *
     * Returns:
     *     The same structure with strings coerced where applicable.
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
     * Args:
     *     config: Configuration record after all transformations.
     *
     * Raises:
     *     Error: When ENVIRONMENT is not one of the allowed values.
     */
    // Vérification de la validité de la valeur d'environnement
    private validateEnvironment(config: ConfigRecord): void {
        const validEnvironments = ['development', 'production'];
        const environment = config['ENVIRONMENT'] as string;

        if (!validEnvironments.includes(environment)) {
            throw new Error(
                `Invalid environment: ${environment}. Must be one of: ${validEnvironments.join(', ')}`
            );
        }
    }

    /**
     * Validates that all required configuration fields are present and non-empty.
     *
     * Args:
     *     config: Configuration record after all transformations.
     *
     * Raises:
     *     Error: When one or more required fields are absent.
     */
    // Validation de la présence des champs obligatoires au démarrage
    private validateRequiredFields(config: ConfigRecord): void {
        const required: { path: string; label: string }[] = [
            { path: 'API.PORT',                            label: 'PORT' },
            { path: 'DATABASE_ROUTING.DEFAULT_DATABASE',   label: 'DEFAULT_DATABASE' },
            { path: 'DATABASE_ROUTING.ALLOWED_DATABASES',  label: 'ALLOWED_DATABASES' },
            { path: 'DATABASE.POOL.MAX_CONNECTIONS',       label: 'DB_MAX_CONNECTIONS' },
            { path: 'SECURITY.RATE_LIMIT.MAX_REQUESTS',    label: 'RATE_LIMIT_MAX_REQUESTS' }
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
                `Check your environment variables or config files.`
            );
        }

        // Présence d'au moins un catalogue configuré
        const catalogs = config['CATALOGS'] as Record<string, unknown> | undefined;
        if (!catalogs || Object.keys(catalogs).length === 0) {
            throw new Error(
                'No catalogs configured. Add at least one entry to CATALOGS in database.yaml.'
            );
        }
    }

    /**
     * Retrieves a configuration value by dot-separated path.
     *
     * Args:
     *     dotPath: Dot-separated key path, e.g. "API.PORT".
     *     defaultValue: Value returned when the path does not exist.
     *
     * Returns:
     *     The value at the given path, or defaultValue when absent.
     */
    // Accès à une valeur de configuration par chemin en pointillés
    get(dotPath: string, defaultValue: unknown = null): unknown {
        // Chargement à la demande si la configuration n'existe pas encore
        if (!this.config) this.loadConfig();

        return dotPath.split('.').reduce<unknown>(
            (obj, key) =>
                obj !== null && obj !== undefined
                    ? (obj as ConfigRecord)[key]
                    : defaultValue,
            this.config
        ) ?? defaultValue;
    }
}

// Instanciation du loader et chargement immédiat de la configuration
const configLoader = new ConfigLoader();
const config = configLoader.loadConfig();

export { configLoader, config };
export type { AppConfig, ConfigRecord };
