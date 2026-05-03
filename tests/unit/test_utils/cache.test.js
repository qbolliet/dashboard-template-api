// Unit tests for withCache (src/utils/cache.js)
// Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
import { jest } from '@jest/globals';

// ─── Shared mutable mock state ────────────────────────────────────────────────

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};

const mockConfig = {
  API: {
    TIMEOUTS: { CACHE_DEFAULT: 300 },
  },
};

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/cache/index.js', () => ({
  redis: mockRedis,
}));

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// ─── Dynamic import ───────────────────────────────────────────────────────────

let withCache;

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
      const result = await withCache('test:key', loader);

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

      const result = await withCache('test:miss', loader);

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
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue('OK');

      const loader = jest.fn().mockResolvedValue({ ok: true });
      await withCache('test:custom-ttl', loader, 60);

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
      const { redis } = await import('../../../src/cache/index.js');
      const originalGet = redis.get;
      delete redis.get;

      const loader = jest.fn().mockResolvedValue({ fallback: true });
      const result = await withCache('test:no-redis', loader);

      expect(result).toEqual({ fallback: true });
      expect(loader).toHaveBeenCalledTimes(1);

      redis.get = originalGet;
    });
  });

  describe('error handling', () => {
    test('falls back to loader when redis.get throws', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis connection failed'));

      const data = { recovered: true };
      const loader = jest.fn().mockResolvedValue(data);

      const result = await withCache('test:redis-error', loader);

      expect(result).toEqual(data);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    test('falls back to loader when redis.set throws after cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockRejectedValue(new Error('Redis write failed'));

      const data = { value: 1 };
      const loader = jest.fn().mockResolvedValue(data);

      const result = await withCache('test:set-error', loader);

      expect(result).toEqual(data);
    });
  });
});
