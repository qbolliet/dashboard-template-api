// Configuration de Jest pour les tests

export default {
  // Utiliser le testEnvironment node pour les tests backend
  testEnvironment: 'node',
  
  // Support des modules ES6
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1'
  },
  
  // Transformation des modules - disable transforms for ES modules
  transform: {},
  transformIgnorePatterns: [
    'node_modules/(?!(chalk|graphql-request|other-esm-modules)/)'
  ],
  
  // Patterns des fichiers de test
  testMatch: [
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.js'
  ],
  
  // Ignorer ces dossiers
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
    '/test-data/'
  ],
  
  // Coverage
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/server.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  
  // Timeout pour les tests (utile pour les tests de base de données)
  testTimeout: 30000,
  
  // Variables d'environnement pour les tests
  testEnvironmentOptions: {
    NODE_ENV: 'test'
  },
  
  // Setup des tests
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,

  // Verbose output for debugging
  verbose: true,

  // Run tests sequentially to avoid DB connection races across resolver test files
  maxWorkers: 1,

  // Force exit after all tests to cleanly close persistent connections
  forceExit: true
};