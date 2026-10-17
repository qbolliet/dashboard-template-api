/**
 * Integration tests for cache invalidation against a real Redis (I1).
 *
 * The unit suite mocks `redis.scan`, which hides the interaction between
 * ioredis' `keyPrefix` and SCAN (the prefix is applied to GET/SET/DEL but not
 * to SCAN's MATCH pattern nor to the keys it returns). These tests write keys
 * through the shared client, invalidate them through the manager and read them
 * back, so a regression of the prefix handling leaves keys behind and fails.
 *
 * Requires the Redis of the test environment (REDIS_HOST/REDIS_PORT, key prefix
 * `test:api:`); the suite is skipped, with a warning, when it is unreachable.
 */

import { redis } from '../../src/cache/index.js';
import { CacheInvalidationManager } from '../../src/cache/cache-invalidation.js';

const manager = new CacheInvalidationManager();

// Clés au format des loaders : <type>:<catalogue>:<schéma>@<version>:<requête>
const KEYS = {
  mainFacts: 'facts:itest:main@v1:q1',
  mainFactsOtherVersion: 'facts:itest:main@v2:q2',
  mainMetadata: 'metadata:itest:main@v1:q3',
  tradeFacts: 'facts:itest:trade@v1:q4',
  otherCatalog: 'facts:itest-other:main@v1:q5',
};

/**
 * Tells whether the test Redis answers.
 *
 * @returns True when a PING succeeds.
 */
// Détection d'un Redis joignable : sans lui, la suite est sautée
const redisReachable = async (): Promise<boolean> => {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
};

/**
 * Lists which of the fixture keys still exist.
 *
 * @returns Names of the fixture keys present in Redis.
 */
// Clés de fixture encore présentes (EXISTS applique le préfixe du client)
const remaining = async (): Promise<string[]> => {
  const present: string[] = [];
  for (const [name, key] of Object.entries(KEYS)) {
    if ((await redis.exists(key)) === 1) present.push(name);
  }
  return present.sort();
};

let available = false;

beforeAll(async () => {
  available = await redisReachable();
  if (!available) console.warn('Redis unreachable: cache-invalidation-redis tests are skipped');
}, 20000);

beforeEach(async () => {
  if (!available) return;
  await Promise.all(Object.values(KEYS).map((key) => redis.set(key, '1', 'EX', 60)));
});

afterEach(async () => {
  if (available) await redis.del(...Object.values(KEYS));
});

afterAll(async () => {
  if (available) await redis.quit();
  else redis.disconnect();
});

/** Registers a test that is a no-op when Redis is unreachable. */
const itRedis = (name: string, fn: () => Promise<void>): void => {
  test(name, async () => {
    if (!available) return;
    await fn();
  });
};

describe('CacheInvalidationManager on a real Redis', () => {
  itRedis('scanKeys returns prefix-free keys that DEL can use directly', async () => {
    const keys = await manager.scanKeys('facts:itest:*');
    expect(keys.sort()).toEqual(
      [KEYS.mainFacts, KEYS.mainFactsOtherVersion, KEYS.tradeFacts].sort(),
    );
  });

  itRedis('invalidateCatalog without schema deletes every schema of the catalog', async () => {
    await manager.invalidateCatalog('itest');
    expect(await remaining()).toEqual(['otherCatalog']);
  });

  itRedis('invalidateCatalog with a schema deletes every version of that schema only', async () => {
    await manager.invalidateCatalog('itest', 'main');
    expect(await remaining()).toEqual(['otherCatalog', 'tradeFacts']);
  });

  itRedis('invalidateCacheType deletes one cache type only', async () => {
    await manager.invalidateCacheType('facts', 'itest', 'main');
    expect(await remaining()).toEqual(['mainMetadata', 'otherCatalog', 'tradeFacts']);
  });

  itRedis('the all-types pattern of a catalog does not match another catalog', async () => {
    const keys = await manager.scanKeys(manager.keyPatterns.allCatalog('itest-other'));
    expect(keys).toEqual([KEYS.otherCatalog]);
  });
});
