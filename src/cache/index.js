// Importation des éléments du dossier
import { createRedisClient } from './redis.js';

// Initialisation d'un instance redis utilisée dans l'application
const redis = createRedisClient();

// Ré-exportation des fonctions d'intérêt
export { redis, createRedisClient };
  