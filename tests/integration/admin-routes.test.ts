/**
 * HTTP integration tests of the admin endpoints hardening.
 *
 * Mounts an Express app in the same order as src/server.ts — `trust proxy`
 * first, then the strict admin limiter of the SecurityManager on /api/cache and
 * /api/catalog, then routes guarded by requireAdminKey — and drives it with
 * supertest. The route handlers are stubs: the real ones need DuckDB and Redis,
 * and a rejected key never reaches them anyway.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { SecurityManager } from '../../src/security/manager.js';
import { requireAdminKey } from '../../src/security/admin-auth.js';
import { parseTrustedProxies } from '../../src/security/trusted-proxies.js';
import { config } from '../../src/utils/config-loader.js';

// ─── Utilitaires ─────────────────────────────────────────────────────────────

const ADMIN_KEY = 'test-admin-key';

/**
 * Builds the admin part of the server around a fresh SecurityManager.
 *
 * @returns The app and the manager to clean up.
 */
const buildApp = (): { app: Express; manager: SecurityManager } => {
  // Budget par défaut de l'administration (10 req/min/IP), limitation activée
  const manager = new SecurityManager({ ...config.SECURITY, ADMIN_RATE_LIMIT: { ENABLED: true } });
  const app = express();

  // Ingress simulé : pair 10.42.0.7, dans le CIDR de confiance
  app.set('trust proxy', parseTrustedProxies('["10.0.0.0/8"]'));
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '10.42.0.7', configurable: true });
    next();
  });

  // Limiteur strict avant la vérification de la clé — comme dans src/server.ts
  app.use(['/api/cache', '/api/catalog'], manager.createAdminRateLimitMiddleware());
  app.post('/api/cache/invalidate-all', requireAdminKey, (_req, res) => {
    res.json({ success: true });
  });
  app.post('/api/catalog/reload', requireAdminKey, (_req, res) => {
    res.json({ success: true });
  });

  return { app, manager };
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Admin endpoints (HTTP)', () => {
  let previousKey: string | undefined;
  let manager: SecurityManager | null = null;

  beforeAll(() => {
    previousKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previousKey;
  });

  afterEach(async () => {
    if (manager) await manager.cleanup();
    manager = null;
  });

  test('answers 429 from the 11th wrong key within a minute', async () => {
    const built = buildApp();
    manager = built.manager;

    for (let i = 0; i < 10; i++) {
      const denied = await request(built.app)
        .post('/api/cache/invalidate-all')
        .set('x-forwarded-for', '1.1.1.1')
        .set('x-admin-key', `wrong-${i}`);
      expect(denied.status).toBe(401);
    }

    const limited = await request(built.app)
      .post('/api/cache/invalidate-all')
      .set('x-forwarded-for', '1.1.1.1')
      .set('x-admin-key', 'wrong-10');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    // Même la bonne clé est refusée tant que la fenêtre n'a pas expiré
    const blocked = await request(built.app)
      .post('/api/cache/invalidate-all')
      .set('x-forwarded-for', '1.1.1.1')
      .set('x-admin-key', ADMIN_KEY);
    expect(blocked.status).toBe(429);
  });

  test('shares one budget between /api/cache and /api/catalog', async () => {
    const built = buildApp();
    manager = built.manager;

    for (let i = 0; i < 5; i++) {
      await request(built.app).post('/api/cache/invalidate-all').set('x-forwarded-for', '1.1.1.1');
      await request(built.app).post('/api/catalog/reload').set('x-forwarded-for', '1.1.1.1');
    }

    const limited = await request(built.app)
      .post('/api/catalog/reload')
      .set('x-forwarded-for', '1.1.1.1')
      .set('x-admin-key', ADMIN_KEY);
    expect(limited.status).toBe(429);
  });

  test('counts per client IP behind the ingress', async () => {
    const built = buildApp();
    manager = built.manager;

    for (let i = 0; i < 11; i++) {
      await request(built.app).post('/api/cache/invalidate-all').set('x-forwarded-for', '1.1.1.1');
    }

    // L'automate de mise à jour, autre IP, garde son budget
    const updater = await request(built.app)
      .post('/api/catalog/reload')
      .set('x-forwarded-for', '2.2.2.2')
      .set('x-admin-key', ADMIN_KEY);
    expect(updater.status).toBe(200);
  });
});
