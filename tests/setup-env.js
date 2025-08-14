// Environment setup for tests - runs before Jest globals are injected
// This file sets up the environment variables and Node.js configuration

// Force test environment
process.env.NODE_ENV = 'test';

// Test database configuration
process.env.DB_PATH = 'test-data/test-database.db';

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