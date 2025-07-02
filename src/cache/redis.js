// Importation des modules
import Redis from 'ioredis';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// Logger pour le cache
const cacheLogger = createContextLogger({ component: 'cache', module: 'redis' });

// Fonction de création du cache
const createRedisClient = () => {
  // Extraction de la configuration
    const redisConfig = config.CACHE.REDIS;
    
    // Construction de la configuration Redis
    const ioredisConfig = {
        host: redisConfig.HOST,
        port: redisConfig.PORT,
        password: redisConfig.PASSWORD,
        keyPrefix: redisConfig.KEY_PREFIX || 'graphql-api:',
        
        retryStrategy: (times) => {
            const delay = Math.min(
                times * redisConfig.OPTIONS.RETRY_STRATEGY.BASE_DELAY,
                redisConfig.OPTIONS.RETRY_STRATEGY.MAX_DELAY
            );
            
            cacheLogger.cache(`Redis retry attempt ${times}`, { delay });
            return delay;
        },
        
        maxRetriesPerRequest: redisConfig.OPTIONS.MAX_RETRIES_PER_REQUEST,
        enableReadyCheck: redisConfig.OPTIONS.ENABLE_READY_CHECK,
        connectTimeout: redisConfig.OPTIONS.CONNECT_TIMEOUT
    };
    
    // Initialisation selon le mode (standalone ou cluster)
    let redis;
    if (redisConfig.CLUSTER?.ENABLED) {
        cacheLogger.cache('Initializing Redis cluster', {
            nodes: redisConfig.CLUSTER.NODES.length
        });
        redis = new Redis.Cluster(redisConfig.CLUSTER.NODES, {
            redisOptions: ioredisConfig
        });
    } else {
        cacheLogger.cache('Initializing Redis standalone');
        redis = new Redis(ioredisConfig);
    }
    
    // Gestion des événements
    redis.on('error', (error) => {
        cacheLogger.error('Redis connection error', error);
    });
    
    redis.on('connect', () => {
        cacheLogger.cache('Successfully connected to Redis');
    });
    
    redis.on('ready', () => {
        cacheLogger.cache('Redis client ready');
    });
    
    redis.on('close', () => {
        cacheLogger.cache('Redis connection closed');
    });
  
    return redis;
};

export { createRedisClient };