// Importation des modules
const Redis = require('ioredis');
import { redisConfig } from '../../config/redis';

// Fonction de création du cache
const createRedisClient = () => {
    // Initialisation
    const redis = new Redis(redisConfig);
    
    // Gestion des erreurs
    redis.on('error', (error) => {
      console.error('Redis connection error:', error);
    });
    
    // Gestion de la connexion au cache
    redis.on('connect', () => {
      console.log('Successfully connected to Redis');
    });
  
    return redis;
};

module.exports = { createRedisClient };