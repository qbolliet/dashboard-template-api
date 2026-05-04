/**
 * Unit tests for RateLimiter (src/security/rate-limiter.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger to isolate the rate-limiter logic.
 * Covers checkLimit, defaultKeyGenerator, _removeExpiredEntries,
 * stop, and cleanup methods.
 */

import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Logger contextuel mocké — quatre méthodes de journalisation. */
interface MockLogger {
  security:  jest.Mock;
  operation: jest.Mock;
  warn:      jest.Mock;
  error:     jest.Mock;
}

/** Requête HTTP minimale utilisée dans les tests du rate limiter. */
interface MockRequest {
  ip?:         string;
  connection?: { remoteAddress?: string };
  headers:     Record<string, string>;
}

/** Données de suivi stockées dans le store du rate limiter pour un client. */
interface ClientData {
  requests:       number[];
  burstCount:     number;
  lastBurstReset: number;
  violations:     number;
}

/** Informations de rate limit renvoyées après une vérification réussie. */
interface RateLimitInfo {
  limit?:          number;
  remaining?:      number;
  reset?:          string;
  burstLimit?:     number;
  burstRemaining?: number;
  skip?:           boolean;
}

/**
 * Interface étendue du RateLimiter exposant les propriétés privées
 * nécessaires aux assertions des tests.
 *
 * Utilisation via double-cast `as unknown as RateLimiterTest` pour
 * contourner les restrictions d'accès TypeScript sur les membres privés.
 */
interface RateLimiterTest {
  checkLimit:             (req: MockRequest) => Promise<RateLimitInfo>;
  defaultKeyGenerator:    (req: Partial<MockRequest>) => string;
  store:                  Map<string, ClientData>;
  cleanupInterval:        ReturnType<typeof setInterval> | null;
  stop:                   () => Promise<void>;
  cleanup:                () => Promise<void>;
  _removeExpiredEntries:  () => void;
}

/** Constructeur du RateLimiter. */
interface RateLimiterConstructor {
  new(config: Record<string, unknown>): RateLimiterTest;
}

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: {}
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: (): MockLogger => ({
    security:  jest.fn(),
    operation: jest.fn(),
    warn:      jest.fn(),
    error:     jest.fn()
  })
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertion d'assignation définitive — assigné dans beforeAll avant tout test.
let RateLimiter!: RateLimiterConstructor;

beforeAll(async () => {
  ({ RateLimiter } =
    await import('../../../src/security/rate-limiter.js') as {
      RateLimiter: RateLimiterConstructor;
    });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  // Double-cast nécessaire pour accéder aux propriétés privées du rate limiter
  let rateLimiter!: RateLimiterTest;

  const mockReq: MockRequest = {
    ip:      '192.168.1.1',
    headers: { 'user-agent': 'test-browser' }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimiter = new RateLimiter({
      MAX_REQUESTS:       10,
      WINDOW_MS:          60000,
      MAX_BURST_REQUESTS: 5,
      BURST_WINDOW_MS:    60000,
      TRUSTED_PROXIES:    []
    }) as unknown as RateLimiterTest;
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
      // Cinq requêtes successives depuis le même client
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }
      const key  = rateLimiter.defaultKeyGenerator(mockReq);
      const data = rateLimiter.store.get(key);
      expect(data?.requests).toHaveLength(5);
    });

    test('throws GraphQLError when burst limit is exceeded', async () => {
      // Épuisement du burst limit (5 requêtes) puis dépassement à la 6e
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
        expect((e as GraphQLError).extensions.code).toBe('RATE_LIMIT_EXCEEDED');
      }
    });

    test('skips check when skip() returns true', async () => {
      // Fonction skip retournant true — le compteur ne doit pas être incrémenté
      const skipLimiter = new RateLimiter({
        MAX_REQUESTS:       1,
        WINDOW_MS:          60000,
        MAX_BURST_REQUESTS: 1,
        BURST_WINDOW_MS:    60000,
        TRUSTED_PROXIES:    [],
        SKIP:               () => true
      }) as unknown as RateLimiterTest;
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
      // Stabilité de la clé — deux appels identiques retournent la même valeur
      const key1 = rateLimiter.defaultKeyGenerator(mockReq);
      const key2 = rateLimiter.defaultKeyGenerator(mockReq);
      expect(key1).toBe(key2);
    });

    test('generates different keys for different IPs', () => {
      const req1: MockRequest = { ip: '192.168.1.1', headers: { 'user-agent': 'browser' } };
      const req2: MockRequest = { ip: '192.168.1.2', headers: { 'user-agent': 'browser' } };
      expect(rateLimiter.defaultKeyGenerator(req1)).not.toBe(rateLimiter.defaultKeyGenerator(req2));
    });

    test('handles missing IP gracefully', () => {
      // Requête sans IP — la clé doit rester une chaîne non vide
      const key = rateLimiter.defaultKeyGenerator({ headers: { 'user-agent': 'bot' } });
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    test('uses x-forwarded-for only for trusted proxies', () => {
      const trustedLimiter = new RateLimiter({
        MAX_REQUESTS:       10,
        WINDOW_MS:          60000,
        MAX_BURST_REQUESTS: 5,
        BURST_WINDOW_MS:    60000,
        TRUSTED_PROXIES:    ['10.0.0.1']
      }) as unknown as RateLimiterTest;

      // Requête via proxy de confiance — utilisation de x-forwarded-for
      const reqFromProxy = {
        ip:         '10.0.0.1',
        connection: { remoteAddress: '10.0.0.1' },
        headers:    { 'user-agent': 'test', 'x-forwarded-for': '203.0.113.1' }
      };
      // Requête via proxy non approuvé — x-forwarded-for ignoré
      const reqNonTrusted = {
        ip:         '8.8.8.8',
        connection: { remoteAddress: '8.8.8.8' },
        headers:    { 'user-agent': 'test', 'x-forwarded-for': '203.0.113.1' }
      };
      const trustedKey   = trustedLimiter.defaultKeyGenerator(reqFromProxy);
      const untrustedKey = trustedLimiter.defaultKeyGenerator(reqNonTrusted);
      expect(trustedKey).not.toBe(untrustedKey);
      trustedLimiter.stop();
    });

    test('ignores x-forwarded-for for untrusted IPs', () => {
      const limiter = new RateLimiter({
        MAX_REQUESTS: 10, WINDOW_MS: 60000, MAX_BURST_REQUESTS: 5, BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: []
      }) as unknown as RateLimiterTest;

      const req = {
        ip:         '8.8.8.8',
        connection: { remoteAddress: '8.8.8.8' },
        headers:    { 'user-agent': 'test', 'x-forwarded-for': '1.2.3.4' }
      };
      const reqNoForward = {
        ip:         '8.8.8.8',
        connection: { remoteAddress: '8.8.8.8' },
        headers:    { 'user-agent': 'test' }
      };
      // Sans proxy de confiance, x-forwarded-for est ignoré → même clé
      expect(limiter.defaultKeyGenerator(req)).toBe(limiter.defaultKeyGenerator(reqNoForward));
      limiter.stop();
    });
  });

  describe('_removeExpiredEntries', () => {
    test('removes entries whose requests have all expired', () => {
      // Entrée avec timestamp expiré (il y a 2 minutes) — doit être supprimée
      const key = 'expired-key';
      rateLimiter.store.set(key, {
        requests:       [Date.now() - 120000],
        burstCount:     0,
        lastBurstReset: Date.now() - 120000,
        violations:     0
      });
      rateLimiter._removeExpiredEntries();
      expect(rateLimiter.store.has(key)).toBe(false);
    });

    test('keeps entries that still have fresh requests', () => {
      // Entrée avec timestamp récent — doit être conservée
      const key = 'fresh-key';
      rateLimiter.store.set(key, {
        requests:       [Date.now()],
        burstCount:     0,
        lastBurstReset: Date.now(),
        violations:     0
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
      }) as unknown as RateLimiterTest;
      await limiter.cleanup();
      expect(limiter.cleanupInterval).toBeNull();
    });
  });
});
