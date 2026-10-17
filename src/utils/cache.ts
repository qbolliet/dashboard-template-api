// Importation du client Redis et de la configuration
import { redis } from '../cache/index.js';
import { config } from './config-loader.js';
import { logger } from './logger.js';

/**
 * Wraps a data loader with a Redis cache layer.
 *
 * On cache hit, returns the parsed JSON value without calling the loader.
 * On cache miss, calls the loader, stores the result, then returns it.
 *
 * A Redis failure never fails the call: an unavailable client or a failed
 * read falls back to the loader (a corrupt entry counts as a miss), a failed
 * write still returns the loaded value. A loader error, on the other hand,
 * is rethrown unchanged and the loader is never called twice.
 *
 * @param key - Redis cache key.
 * @param loader - Async function that fetches the data when the cache misses.
 * @param timeout - TTL in seconds for the cached entry.
 * @returns The cached or freshly loaded value.
 * @throws Whatever the loader throws, unchanged.
 */
// Décorateur de mise en cache Redis pour les fonctions de chargement de données
const withCache = async <T>(
  key: string,
  loader: () => Promise<T>,
  timeout: number = config.API.TIMEOUTS.CACHE_DEFAULT,
): Promise<T> => {
  // Utilisation directe du loader si Redis n'est pas disponible
  if (!redis || typeof redis.get !== 'function') {
    return loader();
  }

  // Lecture du cache : une panne Redis vaut une absence d'entrée
  let cached: string | null = null;
  try {
    cached = await redis.get(key);
  } catch (error) {
    logger.warn(`Cache read failed for ${key}, falling back to the loader`, {
      error: (error as Error).message,
    });
  }
  if (cached) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // Entrée illisible : traitée comme une absence d'entrée
    }
  }

  // Chargement des données : une erreur du loader remonte, sans second appel
  const result = await loader();

  // Écriture du cache : un échec n'empêche pas de rendre la valeur chargée
  try {
    await redis.set(key, JSON.stringify(result), 'EX', timeout);
  } catch (error) {
    logger.warn(`Cache write failed for ${key}`, { error: (error as Error).message });
  }
  return result;
};

export { withCache };
