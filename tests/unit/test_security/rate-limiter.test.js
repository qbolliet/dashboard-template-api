// Unit tests for src/security/rate-limiter.js
import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: {}
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    security: jest.fn(),
    operation: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let RateLimiter;

beforeAll(async () => {
  ({ RateLimiter } = await import('../../../src/security/rate-limiter.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  let rateLimiter;

  const mockReq = { ip: '192.168.1.1', headers: { 'user-agent': 'test-browser' } };

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimiter = new RateLimiter({
      MAX_REQUESTS: 10,
      WINDOW_MS: 60000,
      MAX_BURST_REQUESTS: 5,
      BURST_WINDOW_MS: 60000,
      TRUSTED_PROXIES: []
    });
  });

  afterEach(async () => {
    await rateLimiter.stop();
  });

  describe('checkLimit', () => {
    test('returns rateLimitInfo object within limit', async () => {
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result).toBeDefined();
      expect(result.limit).toBe(10);
      expect(typeof result.remaining).toBe('number');
    });

    test('tracks request count correctly', async () => {
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }
      const key = rateLimiter.defaultKeyGenerator(mockReq);
      const data = rateLimiter.store.get(key);
      expect(data.requests).toHaveLength(5);
    });

    test('throws GraphQLError when burst limit is exceeded', async () => {
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }
      await expect(rateLimiter.checkLimit(mockReq)).rejects.toThrow(GraphQLError);
    });

    test('thrown error has RATE_LIMIT_EXCEEDED extension code', async () => {
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }
      try {
        await rateLimiter.checkLimit(mockReq);
      } catch (e) {
        expect(e.extensions.code).toBe('RATE_LIMIT_EXCEEDED');
      }
    });

    test('skips check when skip() returns true', async () => {
      const skipLimiter = new RateLimiter({
        MAX_REQUESTS: 1,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 1,
        BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: [],
        SKIP: () => true
      });
      const result = await skipLimiter.checkLimit(mockReq);
      expect(result).toEqual({ skip: true });
      await skipLimiter.stop();
    });

    test('rateLimitInfo contains burstLimit and burstRemaining', async () => {
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result.burstLimit).toBe(5);
      expect(typeof result.burstRemaining).toBe('number');
    });
  });

  describe('defaultKeyGenerator', () => {
    test('returns a consistent string key for the same request', () => {
      const key1 = rateLimiter.defaultKeyGenerator(mockReq);
      const key2 = rateLimiter.defaultKeyGenerator(mockReq);
      expect(key1).toBe(key2);
    });

    test('generates different keys for different IPs', () => {
      const req1 = { ip: '192.168.1.1', headers: { 'user-agent': 'browser' } };
      const req2 = { ip: '192.168.1.2', headers: { 'user-agent': 'browser' } };
      expect(rateLimiter.defaultKeyGenerator(req1)).not.toBe(rateLimiter.defaultKeyGenerator(req2));
    });

    test('handles missing IP gracefully', () => {
      const key = rateLimiter.defaultKeyGenerator({ headers: { 'user-agent': 'bot' } });
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    test('uses x-forwarded-for only for trusted proxies', () => {
      const trustedLimiter = new RateLimiter({
        MAX_REQUESTS: 10,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 5,
        BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: ['10.0.0.1']
      });
      const reqFromProxy = {
        ip: '10.0.0.1',
        connection: { remoteAddress: '10.0.0.1' },
        headers: { 'user-agent': 'test', 'x-forwarded-for': '203.0.113.1' }
      };
      const reqNonTrusted = {
        ip: '8.8.8.8',
        connection: { remoteAddress: '8.8.8.8' },
        headers: { 'user-agent': 'test', 'x-forwarded-for': '203.0.113.1' }
      };
      const trustedKey = trustedLimiter.defaultKeyGenerator(reqFromProxy);
      const untrustedKey = trustedLimiter.defaultKeyGenerator(reqNonTrusted);
      expect(trustedKey).not.toBe(untrustedKey);
      trustedLimiter.stop();
    });

    test('ignores x-forwarded-for for untrusted IPs', () => {
      const limiter = new RateLimiter({
        MAX_REQUESTS: 10, WINDOW_MS: 60000, MAX_BURST_REQUESTS: 5, BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: []
      });
      const req = {
        ip: '8.8.8.8',
        connection: { remoteAddress: '8.8.8.8' },
        headers: { 'user-agent': 'test', 'x-forwarded-for': '1.2.3.4' }
      };
      const reqNoForward = {
        ip: '8.8.8.8',
        connection: { remoteAddress: '8.8.8.8' },
        headers: { 'user-agent': 'test' }
      };
      // Without trusted proxy, x-forwarded-for is ignored → same key
      expect(limiter.defaultKeyGenerator(req)).toBe(limiter.defaultKeyGenerator(reqNoForward));
      limiter.stop();
    });
  });

  describe('_removeExpiredEntries', () => {
    test('removes entries whose requests have all expired', () => {
      const key = 'expired-key';
      rateLimiter.store.set(key, {
        requests: [Date.now() - 120000],
        burstCount: 0,
        lastBurstReset: Date.now() - 120000,
        violations: 0
      });
      rateLimiter._removeExpiredEntries();
      expect(rateLimiter.store.has(key)).toBe(false);
    });

    test('keeps entries that still have fresh requests', () => {
      const key = 'fresh-key';
      rateLimiter.store.set(key, {
        requests: [Date.now()],
        burstCount: 0,
        lastBurstReset: Date.now(),
        violations: 0
      });
      rateLimiter._removeExpiredEntries();
      expect(rateLimiter.store.has(key)).toBe(true);
    });
  });

  describe('stop / cleanup', () => {
    test('stop clears the store and the interval', async () => {
      await rateLimiter.stop();
      expect(rateLimiter.store.size).toBe(0);
      expect(rateLimiter.cleanupInterval).toBeNull();
    });

    test('cleanup is an alias for stop', async () => {
      const limiter = new RateLimiter({
        MAX_REQUESTS: 5, WINDOW_MS: 60000, MAX_BURST_REQUESTS: 5, BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: []
      });
      await limiter.cleanup();
      expect(limiter.cleanupInterval).toBeNull();
    });
  });
});
