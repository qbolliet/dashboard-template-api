/**
 * HTTP integration tests for the rate-limiting middleware.
 *
 * Mounts an Express app in the same order as src/server.ts — the middleware on
 * /graphql only, health probes outside of it — and drives it with supertest to
 * assert real status codes and headers: 429 with Retry-After on exhaustion,
 * recovery once the window elapses, burst enforcement, and probe exemption.
 *
 * Client identification goes through Express's real `trust proxy` setting
 * (built by parseTrustedProxies from the JSON string of an env override): only
 * the socket address of the proxy hop is simulated, since supertest always
 * connects from the loopback.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { RateLimiter } from '../../src/security/rate-limiter.js';
import { createRateLimitMiddleware } from '../../src/security/rate-limit-middleware.js';
import { parseTrustedProxies } from '../../src/security/trusted-proxies.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Rate-limit configuration used to build a limiter in tests. */
interface TestLimitConfig {
  MAX_REQUESTS: number;
  WINDOW_MS: number;
  MAX_BURST_REQUESTS: number;
  BURST_WINDOW_MS: number;
  TRUSTED_PROXIES: string[];
}

/** Test application plus the handles needed for assertions and cleanup. */
interface TestApp {
  app: Express;
  limiter: RateLimiter;
  graphqlHandler: jest.Mock;
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/** Network options of the test app. */
interface NetworkOptions {
  /** Raw TRUSTED_PROXIES value, as it arrives from the configuration. */
  trustedProxies?: unknown;
  /** Address of the connecting peer (the proxy hop); loopback when omitted. */
  socketAddress?: string;
}

/**
 * Builds a minimal Express app wired like the real server.
 *
 * @param limitConfig - Rate-limit configuration for the shared limiter.
 * @param enabled - Whether enforcement is active.
 * @param network - Trusted proxies and simulated peer address.
 * @returns The app, its limiter and the spied /graphql handler.
 */
const buildApp = (
  limitConfig: TestLimitConfig,
  enabled = true,
  network: NetworkOptions = {},
): TestApp => {
  const limiter = new RateLimiter(limitConfig as unknown as Record<string, unknown>);
  const graphqlHandler = jest.fn();
  const app = express();

  // Réglage réel de trust proxy, avant tout middleware — comme dans src/server.ts
  app.set('trust proxy', parseTrustedProxies(network.trustedProxies));

  // Adresse du pair TCP (le proxy) : seule partie simulée, req.ip reste calculé par Express
  if (network.socketAddress) {
    const socketAddress = network.socketAddress;
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        value: socketAddress,
        configurable: true,
      });
      next();
    });
  }

  // Sondes montées hors du préfixe limité — comme dans src/server.ts
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/ready', (_req, res) => {
    res.json({ status: 'ready' });
  });

  // Limitation puis « middleware Apollo » factice, dans cet ordre
  app.use('/graphql', createRateLimitMiddleware(limiter, { enabled }));
  app.post('/graphql', (_req, res) => {
    graphqlHandler();
    res.json({ data: { ok: true } });
  });

  return { app, limiter, graphqlHandler };
};

/** Configuration nominale : 3 requêtes par fenêtre, rafale non contraignante. */
const windowConfig: TestLimitConfig = {
  MAX_REQUESTS: 3,
  WINDOW_MS: 1000,
  MAX_BURST_REQUESTS: 100,
  BURST_WINDOW_MS: 1000,
  TRUSTED_PROXIES: [],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Rate limiting (HTTP)', () => {
  let testApp: TestApp;

  afterEach(async () => {
    if (testApp) await testApp.limiter.cleanup();
  });

  describe('Dépassement de la fenêtre', () => {
    beforeEach(() => {
      testApp = buildApp(windowConfig);
    });

    test('allows requests up to the limit then replies 429', async () => {
      for (let i = 0; i < 3; i++) {
        const ok = await request(testApp.app).post('/graphql').send({ query: '{ a }' });
        expect(ok.status).toBe(200);
      }

      const refused = await request(testApp.app).post('/graphql').send({ query: '{ a }' });
      expect(refused.status).toBe(429);
      // Le handler protégé n'a jamais été atteint par la 4e requête
      expect(testApp.graphqlHandler).toHaveBeenCalledTimes(3);
    });

    test('sets Retry-After and a JSON body carrying retryAfterMs', async () => {
      for (let i = 0; i < 3; i++) {
        await request(testApp.app).post('/graphql').send({ query: '{ a }' });
      }

      const refused = await request(testApp.app).post('/graphql').send({ query: '{ a }' });
      expect(refused.headers['retry-after']).toBeDefined();
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(0);
      expect(refused.body).toEqual({
        error: 'Too many requests',
        retryAfterMs: expect.any(Number),
      });
      expect(refused.body.retryAfterMs).toBeGreaterThan(0);
      expect(refused.body.retryAfterMs).toBeLessThanOrEqual(windowConfig.WINDOW_MS);
    });

    test('exposes the X-RateLimit-* counters on accepted requests', async () => {
      const response = await request(testApp.app).post('/graphql').send({ query: '{ a }' });
      expect(response.headers['x-ratelimit-limit']).toBe('3');
      expect(response.headers['x-ratelimit-remaining']).toBe('3');
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
    });

    test('recovers once the window has elapsed', async () => {
      for (let i = 0; i < 3; i++) {
        await request(testApp.app).post('/graphql').send({ query: '{ a }' });
      }
      expect((await request(testApp.app).post('/graphql').send({ query: '{ a }' })).status).toBe(
        429,
      );

      // Attente de l'expiration de la fenêtre glissante (1 s + marge)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const recovered = await request(testApp.app).post('/graphql').send({ query: '{ a }' });
      expect(recovered.status).toBe(200);
    });
  });

  describe('Rafale', () => {
    test('rejects a burst even when the sustained window is not saturated', async () => {
      // Fenêtre longue très large, rafale limitée à 2 requêtes
      testApp = buildApp({
        MAX_REQUESTS: 1000,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 2,
        BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: [],
      });

      expect((await request(testApp.app).post('/graphql')).status).toBe(200);
      expect((await request(testApp.app).post('/graphql')).status).toBe(200);

      const refused = await request(testApp.app).post('/graphql');
      expect(refused.status).toBe(429);
      expect(refused.body.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('Sondes de disponibilité', () => {
    test('does not rate-limit /health and /ready once /graphql is saturated', async () => {
      testApp = buildApp(windowConfig);

      // Saturation complète du budget sur /graphql
      for (let i = 0; i < 4; i++) {
        await request(testApp.app).post('/graphql').send({ query: '{ a }' });
      }
      expect((await request(testApp.app).post('/graphql')).status).toBe(429);

      // Les sondes restent servies — aucun en-tête de limitation
      const health = await request(testApp.app).get('/health');
      expect(health.status).toBe(200);
      expect(health.headers['x-ratelimit-limit']).toBeUndefined();

      const ready = await request(testApp.app).get('/ready');
      expect(ready.status).toBe(200);
      expect(ready.headers['retry-after']).toBeUndefined();
    });
  });

  describe('Identification derrière un proxy de confiance', () => {
    // Ingress du cluster : pair 10.42.0.7, couvert par le CIDR de confiance
    const behindIngress: NetworkOptions = {
      trustedProxies: '["10.0.0.0/8"]',
      socketAddress: '10.42.0.7',
    };

    test('keeps a distinct counter per forwarded client IP', async () => {
      testApp = buildApp(windowConfig, true, behindIngress);

      for (let i = 0; i < 3; i++) {
        const ok = await request(testApp.app).post('/graphql').set('x-forwarded-for', '1.1.1.1');
        expect(ok.status).toBe(200);
      }
      const refused = await request(testApp.app).post('/graphql').set('x-forwarded-for', '1.1.1.1');
      expect(refused.status).toBe(429);

      // Autre client derrière le même ingress : compteur neuf
      const other = await request(testApp.app).post('/graphql').set('x-forwarded-for', '2.2.2.2');
      expect(other.status).toBe(200);
      expect(other.headers['x-ratelimit-remaining']).toBe('3');
    });

    test('keys on the rightmost untrusted address, not a forged leftmost one', async () => {
      testApp = buildApp(windowConfig, true, behindIngress);

      // Le client préfixe x-forwarded-for d'une adresse différente à chaque requête ;
      // l'ingress ajoute l'adresse réelle 1.1.1.1 à droite
      for (let i = 0; i < 3; i++) {
        const ok = await request(testApp.app)
          .post('/graphql')
          .set('x-forwarded-for', `6.6.6.${i}, 1.1.1.1`);
        expect(ok.status).toBe(200);
      }
      const refused = await request(testApp.app)
        .post('/graphql')
        .set('x-forwarded-for', '6.6.6.99, 1.1.1.1');
      expect(refused.status).toBe(429);
    });
  });

  describe('x-forwarded-for usurpé', () => {
    test('is ignored when no proxy is trusted', async () => {
      testApp = buildApp(windowConfig, true, { trustedProxies: '[]', socketAddress: '10.42.0.7' });

      for (let i = 1; i <= 3; i++) {
        const ok = await request(testApp.app).post('/graphql').set('x-forwarded-for', `${i}.1.1.1`);
        expect(ok.status).toBe(200);
      }
      // Une 4e adresse inventée ne donne pas de nouveau budget : clé = IP du pair
      const refused = await request(testApp.app).post('/graphql').set('x-forwarded-for', '4.1.1.1');
      expect(refused.status).toBe(429);
    });

    test('is ignored when the peer is outside the trusted list', async () => {
      testApp = buildApp(windowConfig, true, {
        trustedProxies: '["10.0.0.0/8"]',
        socketAddress: '203.0.113.5',
      });

      for (let i = 1; i <= 3; i++) {
        await request(testApp.app).post('/graphql').set('x-forwarded-for', `${i}.1.1.1`);
      }
      const refused = await request(testApp.app).post('/graphql').set('x-forwarded-for', '4.1.1.1');
      expect(refused.status).toBe(429);
    });
  });

  describe('User-Agent tournant', () => {
    /**
     * Sends 25 requests from one IP, each with a distinct User-Agent.
     *
     * @param app - Application under test.
     * @returns The status codes, in order.
     */
    const sendRotatingAgents = async (app: Express): Promise<number[]> => {
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const response = await request(app).post('/graphql').set('user-agent', `agent-${i}`);
        statuses.push(response.status);
      }
      return statuses;
    };

    test('is limited after MAX_REQUESTS', async () => {
      testApp = buildApp({
        MAX_REQUESTS: 20,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 1000,
        BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: [],
      });

      const statuses = await sendRotatingAgents(testApp.app);
      expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    });

    test('is limited after MAX_BURST_REQUESTS', async () => {
      testApp = buildApp({
        MAX_REQUESTS: 1000,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 20,
        BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: [],
      });

      const statuses = await sendRotatingAgents(testApp.app);
      expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    });
  });

  describe('Désactivation par configuration', () => {
    test('passes every request through when disabled', async () => {
      testApp = buildApp({ ...windowConfig, MAX_REQUESTS: 1 }, false);

      for (let i = 0; i < 5; i++) {
        const response = await request(testApp.app).post('/graphql');
        expect(response.status).toBe(200);
        expect(response.headers['x-ratelimit-limit']).toBeUndefined();
      }
      expect(testApp.graphqlHandler).toHaveBeenCalledTimes(5);
    });
  });
});
