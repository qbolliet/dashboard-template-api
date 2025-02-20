// Importation des modules
const { redis } = require('../cache');

// Création d'une fonction de cache
const withCache = async (key, loader) => {
  // Tentative de connexion au cache
  try {
      // Extraction du cache
      const cached = await redis.get(key);
      if (cached) {
          return JSON.parse(cached);
      }
      // Sinon chargement des données
      const result = await loader();
      await redis.set(key, JSON.stringify(result), 'EX', 300);
      return result;
  } catch (error) {
      // console.error('Cache operation failed:', error);
      // Si le cache échoue, on  retombe sur le loader
      return loader();
  }
};

exports.withCache = withCache;