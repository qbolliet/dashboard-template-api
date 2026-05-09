// Importation de la fabrique du client Redis
import { createRedisClient } from './redis.js';

/** Shared Redis client instance used across the application. */
const redis = createRedisClient();

// Ré-exportation de l'instance et de la fabrique
/**
 * Shared Redis client instance used across the application.
 * Use {@link createRedisClient} to create additional isolated instances.
 */
export { redis, createRedisClient };
