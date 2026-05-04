// Importation du client Redis et de la configuration
import { redis } from '../cache/index.js';
import { config } from './config-loader.js';

/**
 * Wraps a data loader with a Redis cache layer.
 *
 * On cache hit, returns the parsed JSON value without calling the loader.
 * On cache miss, calls the loader, stores the result, then returns it.
 * If Redis is unavailable or throws, falls back to the loader transparently.
 *
 * Args:
 *     key: Redis cache key.
 *     loader: Async function that fetches the data when the cache misses.
 *     timeout: TTL in seconds for the cached entry.
 *
 * Returns:
 *     The cached or freshly loaded value.
 */
// Décorateur de mise en cache Redis pour les fonctions de chargement de données
const withCache = async <T>(
    key: string,
    loader: () => Promise<T>,
    timeout: number = config.API.TIMEOUTS.CACHE_DEFAULT
): Promise<T> => {
    // Tentative d'accès au cache Redis
    try {
        // Utilisation directe du loader si Redis n'est pas disponible
        if (!redis || typeof redis.get !== 'function') {
            return await loader();
        }

        // Extraction de la valeur en cache
        const cached = await redis.get(key);
        if (cached) {
            return JSON.parse(cached) as T;
        }

        // Chargement des données et mise en cache du résultat
        const result = await loader();
        await redis.set(key, JSON.stringify(result), 'EX', timeout);
        return result;
    } catch {
        // Repli sur le loader en cas d'erreur Redis
        return await loader();
    }
};

export { withCache };
