// Importation de la fabrique du client Redis
import { createRedisClient } from './redis.js';

// Initialisation de l'instance Redis partagée dans l'application
const redis = createRedisClient();

// Ré-exportation de l'instance et de la fabrique
export { redis, createRedisClient };
