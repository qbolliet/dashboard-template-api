// Configuration de Jest pour les tests

export default {
  // Utiliser le testEnvironment node pour les tests backend
  testEnvironment: 'node',
  
  // Support des modules ES6
  
  // Transformation des modules
  transform: {},
  
  // Patterns des fichiers de test
  testMatch: [
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.js'
  ],
  
  // Ignorer ces dossiers
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/'
  ],
  
  // Coverage
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/server.js'
  ],
  
  // Timeout pour les tests (utile pour les tests de base de données)
  testTimeout: 30000,
  
  // Variables d'environnement pour les tests
  testEnvironmentOptions: {
    NODE_ENV: 'test'
  },
  
  // Setup des tests
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js']
};