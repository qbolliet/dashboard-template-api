// Configuration de Jest pour les tests

export default {
  // Utiliser le testEnvironment node pour les tests backend
  testEnvironment: 'node',

  // Modules ES avec support TypeScript
  extensionsToTreatAsEsm: ['.ts'],

  // Mapping des modules — résout les imports .js vers .ts pendant la migration
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1'
  },

  // Transformation : ts-jest pour les fichiers TypeScript, pas de transform pour les .js (ESM natif)
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        // Configuration ts-jest spécifique aux tests — hérite de tsconfig.json.
        // rootDir élargi à '.' pour couvrir tests/ en plus de src/.
        // isolatedModules requis par ts-jest en mode NodeNext/ESM.
        allowJs: true,
        checkJs: false,
        rootDir: '.',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        isolatedModules: true
      }
    }]
  },
  transformIgnorePatterns: [
    'node_modules/(?!(chalk|graphql-request|other-esm-modules)/)'
  ],

  // Patterns des fichiers de test — JS pendant la migration, TS après conversion
  testMatch: [
    '**/tests/**/*.test.js',
    '**/tests/**/*.test.ts',
    '**/__tests__/**/*.js',
    '**/__tests__/**/*.ts'
  ],

  // Ignorer ces dossiers
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
    '/test-data/'
  ],

  // Coverage — inclut les fichiers .ts au fur et à mesure de la conversion
  collectCoverageFrom: [
    'src/**/*.js',
    'src/**/*.ts',
    '!src/index.{js,ts}',
    '!src/server.{js,ts}'
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
  globalSetup: '<rootDir>/tests/setup/setup-test-data.ts',
  setupFiles: ['<rootDir>/tests/setup/setup-env.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/setup.ts'],

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
