// Environment setup for tests - runs before Jest globals are injected
// This file sets up the environment variables and Node.js configuration

// Force test environment (config-loader treats "test" like "development")
process.env.NODE_ENV = 'development';

// Test database configuration — point catalog paths to test DuckLake files
process.env.DB_PATH = 'test-data/test-database.db';
process.env.DEFAULT_CATALOG_PATH = 'data/test-default.ducklake';
process.env.DEFAULT_DATA_PATH = 'data/test-default_data/';
process.env.DEFAULT_READ_ONLY = 'true';
// Redirect macroeconomics and public_finance to local synthetic test catalogs
process.env.MACROECONOMICS_CATALOG_PATH = 'data/test-macroeconomics.ducklake';
process.env.MACROECONOMICS_DATA_PATH = 'data/test-macroeconomics_data/';
process.env.PUBLIC_FINANCE_CATALOG_PATH = 'data/test-public-finance.ducklake';
process.env.PUBLIC_FINANCE_DATA_PATH = 'data/test-public-finance_data/';
process.env.ALLOWED_DATABASES = '["default", "macroeconomics", "public_finance"]';
process.env.ALLOW_CROSS_DATABASE_QUERIES = 'true';

// Redis configuration for tests
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.REDIS_KEY_PREFIX = 'test:api:';

// Disable logging during tests unless DEBUG is set
if (!process.env.DEBUG) {
  process.env.LOG_LEVEL = 'error';
}

// Test-specific configuration overrides
process.env.TEST_MODE = 'true';
process.env.CACHE_TTL = '1000'; // Short cache TTL for tests
process.env.MAX_QUERY_COMPLEXITY = '1000';
process.env.RATE_LIMIT_MAX = '1000'; // Higher limits for tests
// Higher timeouts to absorb DuckDB cold-start latency in test environments
process.env.DIMENSION_TIMEOUT = '15000';
process.env.METADATA_TIMEOUT = '15000';
process.env.SELECT_OPTIONS_TIMEOUT = '15000';

// Mock external services
process.env.DISABLE_EXTERNAL_SERVICES = 'true';

// Console override to reduce noise during tests
if (!process.env.DEBUG) {
  const originalConsole = global.console;
  global.console = {
    ...originalConsole,
    log: () => {}, // Suppress logs
    info: () => {}, // Suppress info
    debug: () => {}, // Suppress debug
    warn: originalConsole.warn, // Keep warnings
    error: originalConsole.error // Keep errors
  };
}