// Importation des modules
import { redis } from '../cache/index.js';
import { config } from './config-loader.js';

// Création d'une fonction de cache
const withCache = async (key, loader, timeout = config.API.TIMEOUTS.CACHE_DEFAULT) => {
  // Tentative de connexion au cache
  try {
    // Vérifie si Redis est disponible et connecté
    if (!redis || typeof redis.get !== 'function') {
        console.log(`Redis not available, using direct loader for key: ${key}`);
        return await loader();
    }
    // Extraction du cache
    const cached = await redis.get(key);
    if (cached) {
        return JSON.parse(cached);
    }
    // Sinon chargement des données
    const result = await loader();
    await redis.set(key, JSON.stringify(result), 'EX', timeout);
    return result;
  } catch (error) {
      console.error('Cache operation failed:', error);
      // Si le cache échoue, on  retombe sur le loader
      return await loader();
  }
};

export { withCache };