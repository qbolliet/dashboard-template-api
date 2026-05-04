/**
 * Unit tests for withCache (src/utils/cache.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Covers cache hit, cache miss, Redis unavailability, and error fallback scenarios.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Interface minimale du client Redis mocké. */
interface MockRedis {
  get: jest.Mock;
  set: jest.Mock;
}

/** Forme minimale de la configuration requise par withCache. */
interface MockConfig {
  API: {
    TIMEOUTS: {
      CACHE_DEFAULT: number;
    };
  };
}

// ─── État mutable des mocks ───────────────────────────────────────────────────

const mockRedis: MockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};

const mockConfig: MockConfig = {
  API: {
    TIMEOUTS: { CACHE_DEFAULT: 300 },
  },
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/cache/index.js', () => ({
  redis: mockRedis,
}));

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertion d'assignation définitive — withCache sera assigné dans beforeAll.
let withCache!: (key: string, loader: () => Promise<unknown>, ttl?: number) => Promise<unknown>;

beforeAll(async () => {
  ({ withCache } = await import('../../../src/utils/cache.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('withCache', () => {
  describe('cache hit', () => {
    test('returns parsed cached value without calling loader', async () => {
      const cached = { data: [1, 2, 3] };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const loader = jest.fn().mockResolvedValue({ data: [99] });
      const result = await withCache('test:key', loader as () => Promise<unknown>);

      expect(result).toEqual(cached);
      expect(loader).not.toHaveBeenCalled();
    });
  });

  describe('cache miss', () => {
    test('calls loader and caches the result when key is not in cache', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue('OK');

      const data = { value: 42 };
      const loader = jest.fn().mockResolvedValue(data);

      const result = await withCache('test:miss', loader as () => Promise<unknown>);

      expect(result).toEqual(data);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'test:miss',
        JSON.stringify(data),
        'EX',
        300
      );
    });

    test('uses provided timeout instead of default', async () => {
      // TTL personnalisé — doit remplacer la valeur par défaut de la config.
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue('OK');

      const loader = jest.fn().mockResolvedValue({ ok: true });
      await withCache('test:custom-ttl', loader as () => Promise<unknown>, 60);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'test:custom-ttl',
        expect.any(String),
        'EX',
        60
      );
    });
  });

  describe('redis unavailable', () => {
    test('calls loader directly when redis has no get method', async () => {
      // Redis sans méthode get — repli direct sur le loader sans tentative de cache.
      const { redis } = await import('../../../src/cache/index.js');
      const originalGet = (redis as MockRedis).get;
      delete (redis as Partial<MockRedis>).get;

      const loader = jest.fn().mockResolvedValue({ fallback: true });
      const result = await withCache('test:no-redis', loader as () => Promise<unknown>);

      expect(result).toEqual({ fallback: true });
      expect(loader).toHaveBeenCalledTimes(1);

      (redis as MockRedis).get = originalGet;
    });
  });

  describe('error handling', () => {
    test('falls back to loader when redis.get throws', async () => {
      // Erreur Redis sur get — dégradation gracieuse vers le loader.
      mockRedis.get.mockRejectedValue(new Error('Redis connection failed'));

      const data = { recovered: true };
      const loader = jest.fn().mockResolvedValue(data);

      const result = await withCache('test:redis-error', loader as () => Promise<unknown>);

      expect(result).toEqual(data);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    test('falls back to loader when redis.set throws after cache miss', async () => {
      // Erreur Redis sur set — la valeur du loader est tout de même retournée.
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockRejectedValue(new Error('Redis write failed'));

      const data = { value: 1 };
      const loader = jest.fn().mockResolvedValue(data);

      const result = await withCache('test:set-error', loader as () => Promise<unknown>);

      expect(result).toEqual(data);
    });
  });
});
