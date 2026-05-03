// Importation des modules ioredis et des utilitaires internes
import { Redis, Cluster } from 'ioredis';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// ─── Logger spécifique au module Redis ───────────────────────────────────────

// Initialisation du logger contextuel pour le module Redis
const cacheLogger = createContextLogger({ component: 'cache', module: 'redis' });

// ─── Interfaces de configuration ─────────────────────────────────────────────

/** Paramètres de la stratégie de reconnexion exponentielle. */
interface RetryStrategyConfig {
    BASE_DELAY: number;
    MAX_DELAY: number;
}

/** Options avancées de connexion au serveur Redis. */
interface RedisOptionsConfig {
    RETRY_STRATEGY: RetryStrategyConfig;
    MAX_RETRIES_PER_REQUEST: number;
    ENABLE_READY_CHECK: boolean;
    CONNECT_TIMEOUT: number;
}

/** Nœud individuel d'un cluster Redis (hôte + port). */
interface RedisClusterNode {
    host: string;
    port: number;
}

/** Configuration du mode cluster Redis avec liste des nœuds. */
interface RedisClusterConfig {
    ENABLED: boolean;
    NODES: RedisClusterNode[];
}

/** Configuration complète du client Redis (standalone ou cluster). */
interface RedisConfig {
    HOST:        string;
    PORT:        number;
    PASSWORD?:   string;
    KEY_PREFIX?: string;
    DB?:         number;
    OPTIONS:     RedisOptionsConfig;
    CLUSTER?:    RedisClusterConfig;
}

// ─── Fabrique du client Redis ─────────────────────────────────────────────────

/**
 * Creates and configures a Redis client in standalone or cluster mode.
 *
 * Reads all connection parameters from the application configuration and
 * attaches event listeners for connection lifecycle logging.
 *
 * Returns:
 *     A connected Redis (standalone) or Cluster instance.
 */
const createRedisClient = (): Redis | Cluster => {
    // Extraction de la configuration Redis depuis la configuration globale
    const redisConfig = config.CACHE.REDIS as unknown as RedisConfig;

    // Construction de la configuration ioredis à partir de la configuration applicative
    const ioredisConfig = {
        host:      redisConfig.HOST,
        port:      redisConfig.PORT,
        password:  redisConfig.PASSWORD,
        keyPrefix: redisConfig.KEY_PREFIX ?? 'graphql-api:',

        // Calcul du délai de reconnexion exponentiel borné entre les tentatives
        retryStrategy: (times: number): number => {
            const delay = Math.min(
                times * redisConfig.OPTIONS.RETRY_STRATEGY.BASE_DELAY,
                redisConfig.OPTIONS.RETRY_STRATEGY.MAX_DELAY
            );
            cacheLogger.cache(`Redis retry attempt ${times}`, { delay });
            return delay;
        },

        maxRetriesPerRequest: redisConfig.OPTIONS.MAX_RETRIES_PER_REQUEST,
        enableReadyCheck:     redisConfig.OPTIONS.ENABLE_READY_CHECK,
        connectTimeout:       redisConfig.OPTIONS.CONNECT_TIMEOUT
    };

    // Initialisation selon le mode (standalone ou cluster)
    let redis: Redis | Cluster;
    if (redisConfig.CLUSTER?.ENABLED) {
        cacheLogger.cache('Initializing Redis cluster', {
            nodes: redisConfig.CLUSTER.NODES.length
        });
        redis = new Cluster(redisConfig.CLUSTER.NODES, {
            redisOptions: ioredisConfig
        });
    } else {
        cacheLogger.cache('Initializing Redis standalone');
        redis = new Redis(ioredisConfig);
    }

    // Gestion des événements du cycle de vie de la connexion
    redis.on('error', (error: Error) => {
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
export type { RedisConfig, RedisOptionsConfig, RetryStrategyConfig, RedisClusterConfig, RedisClusterNode };
