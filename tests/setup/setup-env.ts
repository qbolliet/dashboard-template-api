/**
 * Environment setup file for Jest tests.
 *
 * Runs before Jest globals are injected (setupFiles).
 * Configures environment variables, Node.js settings, and console overrides
 * required by the test suite.
 */

// Initialisation de l'environnement de test — exécution avant l'injection des globals Jest.

// Forçage de l'environnement de développement (config-loader traite "test" comme "development")
process.env.NODE_ENV = 'development';

// Configuration de la base de données de test — pointage vers les fichiers DuckLake de test
process.env.DB_PATH = 'test-data/test-database.db';
process.env.DEFAULT_CATALOG_PATH = 'data/test-default.ducklake';
process.env.DEFAULT_DATA_PATH = 'data/test-default_data/';
process.env.DEFAULT_READ_ONLY = 'true';
// Redirection de macroeconomics et public_finance vers les catalogues synthétiques locaux
process.env.MACROECONOMICS_CATALOG_PATH = 'data/test-macroeconomics.ducklake';
process.env.MACROECONOMICS_DATA_PATH = 'data/test-macroeconomics_data/';
process.env.PUBLIC_FINANCE_CATALOG_PATH = 'data/test-public-finance.ducklake';
process.env.PUBLIC_FINANCE_DATA_PATH = 'data/test-public-finance_data/';
process.env.ALLOWED_CATALOGS = '["default", "macroeconomics", "public_finance"]';
process.env.ALLOW_CROSS_CATALOG_QUERIES = 'true';

// Configuration Redis pour les tests
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.REDIS_KEY_PREFIX = 'test:api:';

// Désactivation du logging pendant les tests sauf si DEBUG est défini
if (!process.env.DEBUG) {
  process.env.LOG_LEVEL = 'error';
}

// Surcharges de configuration spécifiques aux tests
process.env.TEST_MODE = 'true';
process.env.CACHE_TTL = '1000'; // TTL court pour les tests
process.env.MAX_QUERY_COMPLEXITY = '1000';
process.env.RATE_LIMIT_MAX = '1000'; // Limites élevées pour les tests
// Timeouts élevés pour absorber la latence de démarrage à froid de DuckDB en environnement de test
process.env.DIMENSION_TIMEOUT = '15000';
process.env.METADATA_TIMEOUT = '15000';
process.env.SELECT_OPTIONS_TIMEOUT = '15000';

// Désactivation des services externes
process.env.DISABLE_EXTERNAL_SERVICES = 'true';

// Substitution de la console globale pour réduire le bruit pendant les tests
if (!process.env.DEBUG) {
  const originalConsole: Console = global.console;
  global.console = {
    ...originalConsole,
    log: (): void => {}, // Suppression des logs
    info: (): void => {}, // Suppression des infos
    debug: (): void => {}, // Suppression du debug
    warn: originalConsole.warn, // Conservation des avertissements
    error: originalConsole.error, // Conservation des erreurs
  } as Console;
}
