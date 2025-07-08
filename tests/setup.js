// Configuration globale pour les tests

// Désactiver les logs pendant les tests
process.env.LOG_LEVEL = 'error';

// Configuration de test pour la base de données
process.env.DB_PATH = '../outputs/test-database.db';

// Configuration Redis pour les tests
process.env.REDIS_KEY_PREFIX = 'test:';

// Augmenter le timeout global pour les tests
jest.setTimeout(30000);