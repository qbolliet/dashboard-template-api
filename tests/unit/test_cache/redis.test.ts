/**
 * Unit tests for redis.js (src/cache/redis.js).
 *
 * Verifies standalone and cluster Redis client creation, event listener
 * registration, and retry strategy logic (exponential backoff with ceiling).
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Instance ioredis mockée — méthodes de base simulées. */
interface MockIoRedisInstance {
  on:   jest.Mock;
  emit: jest.Mock;
  scan: jest.Mock;
  del:  jest.Mock;
  get:  jest.Mock;
  set:  jest.Mock;
}

/** Configuration de la stratégie de reconnexion Redis. */
interface RetryStrategyConfig {
  BASE_DELAY: number;
  MAX_DELAY:  number;
}

/** Options de connexion Redis. */
interface RedisOptions {
  RETRY_STRATEGY:          RetryStrategyConfig;
  MAX_RETRIES_PER_REQUEST: number;
  ENABLE_READY_CHECK:      boolean;
  CONNECT_TIMEOUT:         number;
}

/** Nœud d'un cluster Redis. */
interface ClusterNode {
  host: string;
  port: number;
}

/** Configuration du cluster Redis. */
interface ClusterConfig {
  ENABLED: boolean;
  NODES:   ClusterNode[];
}

/** Configuration Redis complète. */
interface RedisConfig {
  HOST:       string;
  PORT:       number;
  PASSWORD:   null;
  KEY_PREFIX: string;
  OPTIONS:    RedisOptions;
  CLUSTER:    ClusterConfig;
}

/** Configuration globale mockée — section cache uniquement. */
interface MockConfig {
  CACHE: {
    REDIS: RedisConfig;
  };
}

/** Constructeur Redis mocké — standalone ou cluster. */
interface MockRedisConstructor extends jest.Mock {
  Cluster?: jest.Mock;
  mock: {
    calls: Array<Array<unknown>>;
  };
}

/** Module redis.js après import dynamique. */
interface RedisModule {
  createRedisClient: () => MockIoRedisInstance;
}

// ─── État des mocks ───────────────────────────────────────────────────────────

// Instance partagée — référence stable réutilisée par Redis et Cluster
const mockIoRedisInstance: MockIoRedisInstance = {
  on:   jest.fn(),
  emit: jest.fn(),
  scan: jest.fn(),
  del:  jest.fn(),
  get:  jest.fn(),
  set:  jest.fn(),
};

// Configuration mockée — reflète la structure YAML de config/
const mockConfig: MockConfig = {
  CACHE: {
    REDIS: {
      HOST:       'localhost',
      PORT:       6379,
      PASSWORD:   null,
      KEY_PREFIX: 'test:',
      OPTIONS: {
        RETRY_STRATEGY:          { BASE_DELAY: 50, MAX_DELAY: 2000 },
        MAX_RETRIES_PER_REQUEST: 3,
        ENABLE_READY_CHECK:      true,
        CONNECT_TIMEOUT:         10000,
      },
      CLUSTER: { ENABLED: false, NODES: [] },
    },
  },
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

// Substitution du module ioredis — constructeurs standalone et cluster
jest.unstable_mockModule('ioredis', () => {
  const MockCluster = jest.fn().mockImplementation(() => mockIoRedisInstance);
  const MockRedis   = jest.fn().mockImplementation(() => mockIoRedisInstance);
  MockRedis.Cluster = MockCluster;
  return { default: MockRedis, Redis: MockRedis, Cluster: MockCluster };
});

// Substitution du chargeur de configuration
jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// Substitution du logger — silence des sorties console pendant les tests
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    cache: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  }),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Variables déclarées avant beforeAll — remplies après résolution des mocks
let Redis:             MockRedisConstructor;
let Cluster:           MockRedisConstructor;
let createRedisClient: () => MockIoRedisInstance;

beforeAll(async () => {
  const ioredisModule = await import('ioredis') as unknown as {
    Redis:   MockRedisConstructor;
    Cluster: MockRedisConstructor;
  };
  Redis   = ioredisModule.Redis;
  Cluster = ioredisModule.Cluster;

  const redisModule = await import('../../../src/cache/redis.js') as unknown as RedisModule;
  createRedisClient = redisModule.createRedisClient;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Redis Client (redis.js)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Réenregistrement des implémentations ioredis après resetAllMocks
    Redis.mockImplementation(() => mockIoRedisInstance);
    Cluster.mockImplementation(() => mockIoRedisInstance);
    // Réinitialisation de la configuration cluster
    mockConfig.CACHE.REDIS.CLUSTER.ENABLED = false;
    mockConfig.CACHE.REDIS.CLUSTER.NODES   = [];
  });

  // ── Client standalone ────────────────────────────────────────────────────

  test('creates a standalone client with the config options', () => {
    const client = createRedisClient();

    expect(Redis).toHaveBeenCalledWith(
      expect.objectContaining({
        host:                 'localhost',
        port:                 6379,
        keyPrefix:            'test:',
        maxRetriesPerRequest: 3,
        enableReadyCheck:     true,
        connectTimeout:       10000,
      })
    );
    expect(client).toBe(mockIoRedisInstance);
  });

  // ── Client cluster ───────────────────────────────────────────────────────

  test('creates a cluster client when CLUSTER.ENABLED is true', () => {
    mockConfig.CACHE.REDIS.CLUSTER.ENABLED = true;
    mockConfig.CACHE.REDIS.CLUSTER.NODES   = [
      { host: 'node1', port: 6379 },
      { host: 'node2', port: 6379 },
    ];

    const client = createRedisClient();

    expect(Cluster).toHaveBeenCalledWith(
      [{ host: 'node1', port: 6379 }, { host: 'node2', port: 6379 }],
      expect.any(Object)
    );
    expect(client).toBe(mockIoRedisInstance);
  });

  // ── Écouteurs d'événements ───────────────────────────────────────────────

  test('registers error, connect, ready and close event listeners', () => {
    const client = createRedisClient();

    expect(client.on).toHaveBeenCalledWith('error',   expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('ready',   expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('close',   expect.any(Function));
  });

  // ── Stratégie de reconnexion ─────────────────────────────────────────────

  test('retry strategy applies exponential backoff', () => {
    createRedisClient();
    const { retryStrategy } = Redis.mock.calls[0][0] as { retryStrategy: (times: number) => number };
    expect(retryStrategy).toBeInstanceOf(Function);
    expect(retryStrategy(3)).toBe(150); // 3 × BASE_DELAY(50)
  });

  test('retry strategy is capped at MAX_DELAY', () => {
    createRedisClient();
    const { retryStrategy } = Redis.mock.calls[0][0] as { retryStrategy: (times: number) => number };
    expect(retryStrategy(1000)).toBe(2000); // Plafonnement à MAX_DELAY
  });
});
