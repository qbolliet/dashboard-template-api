/**
 * HTTP integration tests of the access control of `/metrics`.
 *
 * Mounts the guard of src/security/metrics-auth.ts the way src/server.ts does —
 * `trust proxy`, then the strict admin limiter in front of the key check — and
 * drives it with supertest. The handler is a stub: the real one only reads
 * in-memory counters.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { SecurityManager } from '../../src/security/manager.js';
import { createIpMatcher, createMetricsAccess } from '../../src/security/metrics-auth.js';
import { parseTrustedProxies } from '../../src/security/trusted-proxies.js';
import { config } from '../../src/utils/config-loader.js';

const ADMIN_KEY = 'test-admin-key';

/**
 * Builds an app exposing a guarded `/metrics` and an open `/ready`.
 *
 * @param allowedIps - Raw METRICS.ALLOWED_IPS value.
 * @returns The app and the manager to clean up.
 */
const buildApp = (allowedIps: unknown): { app: Express; manager: SecurityManager } => {
  const manager = new SecurityManager({ ...config.SECURITY, ADMIN_RATE_LIMIT: { ENABLED: true } });
  const app = express();

  // Ingress simulé : pair 10.42.0.7, dans le CIDR de confiance
  app.set('trust proxy', parseTrustedProxies('["10.0.0.0/8"]'));
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '10.42.0.7', configurable: true });
    next();
  });

  app.get(
    '/metrics',
    createMetricsAccess({ allowedIps, rateLimit: manager.createAdminRateLimitMiddleware() }),
    (_req, res) => {
      res.json({ requests: { total: 3 } });
    },
  );
  app.get('/ready', (_req, res) => {
    res.json({ status: 'ready' });
  });

  return { app, manager };
};

describe('/metrics access (HTTP)', () => {
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

  test('answers 401 without a key', async () => {
    const built = buildApp([]);
    manager = built.manager;

    const response = await request(built.app).get('/metrics').set('x-forwarded-for', '1.1.1.1');
    expect(response.status).toBe(401);
    expect(response.body.requests).toBeUndefined();
  });

  test('answers 401 with a wrong or repeated key', async () => {
    const built = buildApp([]);
    manager = built.manager;

    const wrong = await request(built.app)
      .get('/metrics')
      .set('x-forwarded-for', '1.1.1.1')
      .set('x-admin-key', 'nope');
    expect(wrong.status).toBe(401);

    const repeated = await request(built.app)
      .get('/metrics')
      .set('x-forwarded-for', '1.1.1.1')
      .set('x-admin-key', [ADMIN_KEY, ADMIN_KEY]);
    expect(repeated.status).toBe(401);
  });

  test('serves the metrics with the admin key', async () => {
    const built = buildApp([]);
    manager = built.manager;

    const response = await request(built.app)
      .get('/metrics')
      .set('x-forwarded-for', '1.1.1.1')
      .set('x-admin-key', ADMIN_KEY);
    expect(response.status).toBe(200);
    expect(response.body.requests.total).toBe(3);
  });

  test('stays closed (401) when ADMIN_API_KEY is unset and the IP is not listed', async () => {
    const built = buildApp([]);
    manager = built.manager;
    delete process.env.ADMIN_API_KEY;
    try {
      const response = await request(built.app)
        .get('/metrics')
        .set('x-forwarded-for', '1.1.1.1')
        .set('x-admin-key', '');
      expect(response.status).toBe(401);
    } finally {
      process.env.ADMIN_API_KEY = ADMIN_KEY;
    }
  });

  test('lets a listed IP through without a key, and no other', async () => {
    const built = buildApp(['192.168.4.0/24', '203.0.113.9']);
    manager = built.manager;

    const inBlock = await request(built.app).get('/metrics').set('x-forwarded-for', '192.168.4.77');
    expect(inBlock.status).toBe(200);

    const single = await request(built.app).get('/metrics').set('x-forwarded-for', '203.0.113.9');
    expect(single.status).toBe(200);

    const other = await request(built.app).get('/metrics').set('x-forwarded-for', '192.168.5.1');
    expect(other.status).toBe(401);
  });

  test('does not trust an address a client prepends to x-forwarded-for', async () => {
    const built = buildApp(['192.168.4.0/24']);
    manager = built.manager;

    // Express retient l'adresse la plus à droite non fiable : 1.1.1.1
    const spoofed = await request(built.app)
      .get('/metrics')
      .set('x-forwarded-for', '192.168.4.5, 1.1.1.1');
    expect(spoofed.status).toBe(401);
  });

  test('limits the key attempts, but not the listed IPs', async () => {
    const built = buildApp(['192.168.4.0/24']);
    manager = built.manager;

    for (let i = 0; i < 10; i++) {
      await request(built.app)
        .get('/metrics')
        .set('x-forwarded-for', '1.1.1.1')
        .set('x-admin-key', `wrong-${i}`);
    }
    const limited = await request(built.app)
      .get('/metrics')
      .set('x-forwarded-for', '1.1.1.1')
      .set('x-admin-key', ADMIN_KEY);
    expect(limited.status).toBe(429);

    for (let i = 0; i < 15; i++) {
      const listed = await request(built.app)
        .get('/metrics')
        .set('x-forwarded-for', '192.168.4.20');
      expect(listed.status).toBe(200);
    }
  });

  test('keeps /ready public', async () => {
    const built = buildApp([]);
    manager = built.manager;

    const response = await request(built.app).get('/ready').set('x-forwarded-for', '1.1.1.1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });
});

describe('createIpMatcher', () => {
  test('matches IPv4, IPv6 and IPv4-mapped addresses against IPs and CIDR blocks', () => {
    const matches = createIpMatcher('["10.0.0.0/8", "2001:db8::/32", "127.0.0.1"]');
    expect(matches('10.9.8.7')).toBe(true);
    expect(matches('::ffff:10.9.8.7')).toBe(true);
    expect(matches('2001:db8::1')).toBe(true);
    expect(matches('127.0.0.1')).toBe(true);
    expect(matches('11.0.0.1')).toBe(false);
    expect(matches('2001:db9::1')).toBe(false);
    expect(matches(undefined)).toBe(false);
    expect(matches('not-an-ip')).toBe(false);
  });

  test('accepts a comma-separated string and matches nothing when empty', () => {
    expect(createIpMatcher('10.0.0.1, 10.0.0.2')('10.0.0.2')).toBe(true);
    expect(createIpMatcher([])('10.0.0.1')).toBe(false);
    expect(createIpMatcher(undefined)('10.0.0.1')).toBe(false);
    expect(createIpMatcher('')('10.0.0.1')).toBe(false);
  });

  test.each(['10.0.0.0/33', 'bogus', '10.0.0.1/8/8', '::1/129', '[1]', '{"a":1}'])(
    'rejects the invalid setting %s at startup',
    (raw) => {
      expect(() => createIpMatcher(raw)).toThrow(/METRICS_ALLOWED_IPS/);
    },
  );
});
