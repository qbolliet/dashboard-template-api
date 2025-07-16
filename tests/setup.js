// Configuration globale pour les tests

// Désactiver les logs pendant les tests
process.env.LOG_LEVEL = 'error';

// Configuration de test pour la base de données
process.env.DB_PATH = 'test-data/test-database.db';

// Configuration Redis pour les tests
process.env.REDIS_KEY_PREFIX = 'test:';

// Mock de certains modules si nécessaire
global.console = {
  ...console,
  // Désactiver console.log pendant les tests sauf si DEBUG est activé
  log: process.env.DEBUG ? console.log : () => {},
  error: console.error,
  warn: console.warn,
  info: () => {},
  debug: () => {}
};