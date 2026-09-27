/**
 * Unit tests for RateLimiter (src/security/rate-limiter.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger to isolate the rate-limiter logic.
 * Covers checkLimit, defaultKeyGenerator, _removeExpiredEntries,
 * stop, and cleanup methods.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Logger contextuel mocké — quatre méthodes de journalisation. */
interface MockLogger {
  security: jest.Mock;
  operation: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

/** Requête HTTP minimale utilisée dans les tests du rate limiter. */
interface MockRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string>;
}

/** Données de suivi stockées dans le store du rate limiter pour un client. */
interface ClientData {
  requests: number[];
  burstCount: number;
  lastBurstReset: number;
  violations: number;
}

/** Décision renvoyée par une vérification de rate limit. */
interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  info: RateLimitInfo;
}

/** Informations de rate limit renvoyées après une vérification réussie. */
interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: string;
  burstLimit?: number;
  burstRemaining?: number;
  skip?: boolean;
}

/**
 * Interface étendue du RateLimiter exposant les propriétés privées
 * nécessaires aux assertions des tests.
 *
 * Utilisation via double-cast `as unknown as RateLimiterTest` pour
 * contourner les restrictions d'accès TypeScript sur les membres privés.
 */
interface RateLimiterTest {
  checkLimit: (req: MockRequest) => Promise<RateLimitDecision>;
  defaultKeyGenerator: (req: Partial<MockRequest>) => string;
  store: Map<string, ClientData>;
  cleanupInterval: ReturnType<typeof setInterval> | null;
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
  _removeExpiredEntries: () => void;
}

/** Constructeur du RateLimiter. */
interface RateLimiterConstructor {
  new (config: Record<string, unknown>): RateLimiterTest;
}

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: {},
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: (): MockLogger => ({
    security: jest.fn(),
    operation: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertion d'assignation définitive — assigné dans beforeAll avant tout test.
let RateLimiter!: RateLimiterConstructor;

beforeAll(async () => {
  ({ RateLimiter } = (await import('../../../src/security/rate-limiter.js')) as {
    RateLimiter: RateLimiterConstructor;
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  // Double-cast nécessaire pour accéder aux propriétés privées du rate limiter
  let rateLimiter!: RateLimiterTest;

  const mockReq: MockRequest = {
    ip: '192.168.1.1',
    headers: { 'user-agent': 'test-browser' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimiter = new RateLimiter({
      MAX_REQUESTS: 10,
      WINDOW_MS: 60000,
      MAX_BURST_REQUESTS: 5,
      BURST_WINDOW_MS: 60000,
      TRUSTED_PROXIES: [],
    }) as unknown as RateLimiterTest;
  });

  afterEach(async () => {
    await rateLimiter.stop();
  });

  describe('checkLimit', () => {
    test('allows the request and returns counters when within limit', async () => {
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
      expect(result.info.limit).toBe(10);
      expect(typeof result.info.remaining).toBe('number');
    });

    test('tracks request count correctly', async () => {
      // Cinq requêtes successives depuis le même client
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }
      const key = rateLimiter.defaultKeyGenerator(mockReq);
      const data = rateLimiter.store.get(key);
      expect(data?.requests).toHaveLength(5);
    });

    test('refuses the request when the burst limit is exceeded', async () => {
      // Épuisement du burst limit (5 requêtes) puis dépassement à la 6e
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60000);
    });

    test('does not consume a slot when the request is refused', async () => {
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }
      await rateLimiter.checkLimit(mockReq);
      const key = rateLimiter.defaultKeyGenerator(mockReq);
      const data = rateLimiter.store.get(key);
      // Cinq requêtes comptées : la 6e, refusée, n'est pas enregistrée
      expect(data?.requests).toHaveLength(5);
      expect(data?.violations).toBe(1);
    });

    test('reports the sustained window delay when it is the binding limit', async () => {
      // Fenêtre longue saturée (2 requêtes) sans saturer la rafale
      const windowLimiter = new RateLimiter({
        MAX_REQUESTS: 2,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 100,
        BURST_WINDOW_MS: 1000,
        TRUSTED_PROXIES: [],
      }) as unknown as RateLimiterTest;
      await windowLimiter.checkLimit(mockReq);
      await windowLimiter.checkLimit(mockReq);
      const result = await windowLimiter.checkLimit(mockReq);
      expect(result.allowed).toBe(false);
      // Le délai suit la fenêtre longue (60 s), pas la fenêtre de rafale (1 s)
      expect(result.retryAfterMs).toBeGreaterThan(1000);
      await windowLimiter.stop();
    });

    test('skips check when skip() returns true', async () => {
      // Fonction skip retournant true — le compteur ne doit pas être incrémenté
      const skipLimiter = new RateLimiter({
        MAX_REQUESTS: 1,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 1,
        BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: [],
        SKIP: () => true,
      }) as unknown as RateLimiterTest;
      const result = await skipLimiter.checkLimit(mockReq);
      expect(result.allowed).toBe(true);
      expect(result.info).toEqual({ skip: true });
      await skipLimiter.stop();
    });

    test('rateLimitInfo contains burstLimit and burstRemaining', async () => {
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result.info.burstLimit).toBe(5);
      expect(typeof result.info.burstRemaining).toBe('number');
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

    test('ignores the User-Agent: one IP, one key', () => {
      const req1: MockRequest = { ip: '192.168.1.1', headers: { 'user-agent': 'browser-a' } };
      const req2: MockRequest = { ip: '192.168.1.1', headers: { 'user-agent': 'browser-b' } };
      expect(rateLimiter.defaultKeyGenerator(req1)).toBe(rateLimiter.defaultKeyGenerator(req2));
    });

    test('keys on req.ip and never reads x-forwarded-for itself', () => {
      // La résolution de x-forwarded-for relève d'Express (trust proxy)
      const forged: MockRequest = {
        ip: '8.8.8.8',
        socket: { remoteAddress: '8.8.8.8' },
        headers: { 'x-forwarded-for': '1.2.3.4' },
      };
      const plain: MockRequest = { ip: '8.8.8.8', headers: {} };
      expect(rateLimiter.defaultKeyGenerator(forged)).toBe(rateLimiter.defaultKeyGenerator(plain));
    });

    test('falls back to the socket address when req.ip is absent', () => {
      const viaSocket: MockRequest = { socket: { remoteAddress: '8.8.8.8' }, headers: {} };
      const viaIp: MockRequest = { ip: '8.8.8.8', headers: {} };
      expect(rateLimiter.defaultKeyGenerator(viaSocket)).toBe(
        rateLimiter.defaultKeyGenerator(viaIp),
      );
    });
  });

  describe('_removeExpiredEntries', () => {
    test('removes entries whose requests have all expired', () => {
      // Entrée avec timestamp expiré (il y a 2 minutes) — doit être supprimée
      const key = 'expired-key';
      rateLimiter.store.set(key, {
        requests: [Date.now() - 120000],
        burstCount: 0,
        lastBurstReset: Date.now() - 120000,
        violations: 0,
      });
      rateLimiter._removeExpiredEntries();
      expect(rateLimiter.store.has(key)).toBe(false);
    });

    test('keeps entries that still have fresh requests', () => {
      // Entrée avec timestamp récent — doit être conservée
      const key = 'fresh-key';
      rateLimiter.store.set(key, {
        requests: [Date.now()],
        burstCount: 0,
        lastBurstReset: Date.now(),
        violations: 0,
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
        MAX_REQUESTS: 5,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 5,
        BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: [],
      }) as unknown as RateLimiterTest;
      await limiter.cleanup();
      expect(limiter.cleanupInterval).toBeNull();
    });
  });
});
