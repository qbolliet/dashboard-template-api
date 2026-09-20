/**
 * HTTP integration tests for the rate-limiting middleware.
 *
 * Mounts an Express app in the same order as src/server.ts — the middleware on
 * /graphql only, health probes outside of it — and drives it with supertest to
 * assert real status codes and headers: 429 with Retry-After on exhaustion,
 * recovery once the window elapses, burst enforcement, and probe exemption.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { RateLimiter } from '../../src/security/rate-limiter.js';
import { createRateLimitMiddleware } from '../../src/security/rate-limit-middleware.js';

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

/**
 * Builds a minimal Express app wired like the real server.
 *
 * @param limitConfig - Rate-limit configuration for the shared limiter.
 * @param enabled - Whether enforcement is active.
 * @returns The app, its limiter and the spied /graphql handler.
 */
const buildApp = (limitConfig: TestLimitConfig, enabled = true): TestApp => {
  const limiter = new RateLimiter(limitConfig as unknown as Record<string, unknown>);
  const graphqlHandler = jest.fn();
  const app = express();

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

  describe('Isolation des clients', () => {
    test('keeps a separate budget per user-agent', async () => {
      testApp = buildApp(windowConfig);

      for (let i = 0; i < 4; i++) {
        await request(testApp.app).post('/graphql').set('user-agent', 'client-a');
      }
      expect(
        (await request(testApp.app).post('/graphql').set('user-agent', 'client-a')).status,
      ).toBe(429);

      // Un autre client dispose de son propre budget
      const other = await request(testApp.app).post('/graphql').set('user-agent', 'client-b');
      expect(other.status).toBe(200);
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
