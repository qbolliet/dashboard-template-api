// Unit tests for redis.js
// Uses jest.unstable_mockModule + dynamic imports because transform:{} disables Babel hoisting.
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mutable mock objects (declared before mock registration)
// ---------------------------------------------------------------------------

const mockIoRedisInstance = {
  on: jest.fn(),
  emit: jest.fn(),
  scan: jest.fn(),
  del: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
};

const mockConfig = {
  CACHE: {
    REDIS: {
      HOST: 'localhost',
      PORT: 6379,
      PASSWORD: null,
      KEY_PREFIX: 'test:',
      OPTIONS: {
        RETRY_STRATEGY: { BASE_DELAY: 50, MAX_DELAY: 2000 },
        MAX_RETRIES_PER_REQUEST: 3,
        ENABLE_READY_CHECK: true,
        CONNECT_TIMEOUT: 10000,
      },
      CLUSTER: { ENABLED: false, NODES: [] },
    },
  },
};

// ---------------------------------------------------------------------------
// Register mocks BEFORE any dynamic import of the mocked modules
// ---------------------------------------------------------------------------

jest.unstable_mockModule('ioredis', () => {
  const MockRedis = jest.fn().mockImplementation(() => mockIoRedisInstance);
  MockRedis.Cluster = jest.fn().mockImplementation(() => mockIoRedisInstance);
  return { default: MockRedis };
});

jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    cache: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Dynamic imports — loaded after mocks are registered
// ---------------------------------------------------------------------------

let Redis;
let createRedisClient;

beforeAll(async () => {
  const ioredisModule = await import('ioredis');
  Redis = ioredisModule.default;

  const redisModule = await import('../../src/cache/redis.js');
  createRedisClient = redisModule.createRedisClient;
});

// ---------------------------------------------------------------------------
// Redis Client (redis.js)
// ---------------------------------------------------------------------------

describe('Redis Client (redis.js)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Re-register ioredis implementations after resetAllMocks clears them
    Redis.mockImplementation(() => mockIoRedisInstance);
    Redis.Cluster = jest.fn().mockImplementation(() => mockIoRedisInstance);
    // Reset cluster config
    mockConfig.CACHE.REDIS.CLUSTER.ENABLED = false;
    mockConfig.CACHE.REDIS.CLUSTER.NODES = [];
  });

  test('creates a standalone client with the config options', () => {
    const client = createRedisClient();

    expect(Redis).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'localhost',
        port: 6379,
        keyPrefix: 'test:',
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 10000,
      })
    );
    expect(client).toBe(mockIoRedisInstance);
  });

  test('creates a cluster client when CLUSTER.ENABLED is true', () => {
    mockConfig.CACHE.REDIS.CLUSTER.ENABLED = true;
    mockConfig.CACHE.REDIS.CLUSTER.NODES = [
      { host: 'node1', port: 6379 },
      { host: 'node2', port: 6379 },
    ];

    const client = createRedisClient();

    expect(Redis.Cluster).toHaveBeenCalledWith(
      [{ host: 'node1', port: 6379 }, { host: 'node2', port: 6379 }],
      expect.any(Object)
    );
    expect(client).toBe(mockIoRedisInstance);
  });

  test('registers error, connect, ready and close event listeners', () => {
    const client = createRedisClient();

    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('ready', expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  test('retry strategy applies exponential backoff', () => {
    createRedisClient();
    const { retryStrategy } = Redis.mock.calls[0][0];
    expect(retryStrategy).toBeInstanceOf(Function);
    expect(retryStrategy(3)).toBe(150); // 3 * BASE_DELAY(50)
  });

  test('retry strategy is capped at MAX_DELAY', () => {
    createRedisClient();
    const { retryStrategy } = Redis.mock.calls[0][0];
    expect(retryStrategy(1000)).toBe(2000); // capped at 2000
  });
});
