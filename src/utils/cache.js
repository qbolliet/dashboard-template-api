// Importation des modules
const { redis } = require('../cache');

// Création d'une fonction de cache
const withCache = async (key, loader) => {
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }
  const result = await loader();
  await redis.set(key, JSON.stringify(result), 'EX', 300);
  return result;
};

exports.withCache = withCache;