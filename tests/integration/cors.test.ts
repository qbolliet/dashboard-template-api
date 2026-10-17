/**
 * HTTP integration tests of CORS and of catalog/schema targeting.
 *
 * Mounts a minimal Express app around the real createCorsMiddleware (same
 * config shape as config/api.yaml) and drives it with supertest: an allowed
 * origin gets Access-Control-Allow-Origin on both preflight and the real
 * request, a disallowed one gets none, no Access-Control-Allow-Credentials is
 * ever sent (CORS.CREDENTIALS is false), and X-Powered-By is absent.
 *
 * Also exercises the real createContext of src/server.ts: catalog and schema
 * are resolved from GraphQL arguments only — an `x-catalog-id` / `x-schema-id`
 * header carries no routing information at all, fix!: target catalogs by
 * arguments only.
 */

import { describe, test, expect } from '@jest/globals';
import express from 'express';
import type { Express, Request, Response } from 'express';
import request from 'supertest';
import { createCorsMiddleware, parseCorsOrigins } from '../../src/security/cors.js';
import { createContext } from '../../src/server.js';
import type { ServerContext } from '../../src/server.js';

// ─── CORS ────────────────────────────────────────────────────────────────────

/**
 * Builds a minimal app around the real CORS middleware.
 *
 * @param origins - Allowed origins, as CORS.ORIGINS would resolve to.
 * @returns Express app with a trivial GET /ping route.
 */
const buildCorsApp = (origins: string[]): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    createCorsMiddleware({
      ORIGINS: origins,
      CREDENTIALS: false,
      METHODS: ['GET', 'POST', 'OPTIONS'],
      HEADERS: ['Content-Type', 'Authorization'],
      MAX_AGE: 86400,
    }),
  );
  app.get('/ping', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
};

describe('CORS (src/security/cors.ts)', () => {
  const ALLOWED = 'https://qbolliet.github.io';
  const OTHER = 'https://evil.example.com';

  test('parseCorsOrigins: empty/absent resolves to no allowed origin', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins(null)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('[]')).toEqual([]);
  });

  test('parseCorsOrigins: JSON array (CORS_ORIGINS env form)', () => {
    expect(parseCorsOrigins(`["${ALLOWED}"]`)).toEqual([ALLOWED]);
  });

  test('preflight from an allowed origin answers 204 with Allow-Origin', async () => {
    const app = buildCorsApp([ALLOWED]);
    const res = await request(app).options('/ping').set('Origin', ALLOWED);

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-max-age']).toBe('86400');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  test('preflight from a disallowed origin answers with no Allow-Origin', async () => {
    const app = buildCorsApp([ALLOWED]);
    const res = await request(app).options('/ping').set('Origin', OTHER);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('a real request from an allowed origin carries Allow-Origin', async () => {
    const app = buildCorsApp([ALLOWED]);
    const res = await request(app).get('/ping').set('Origin', ALLOWED);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  test('a real request from a disallowed origin carries no Allow-Origin', async () => {
    const app = buildCorsApp([ALLOWED]);
    const res = await request(app).get('/ping').set('Origin', OTHER);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('X-Powered-By is never sent', async () => {
    const app = buildCorsApp([ALLOWED]);
    const res = await request(app).get('/ping').set('Origin', ALLOWED);

    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// ─── Routage catalogue/schéma : arguments seulement ───────────────────────────

describe('createContext (src/server.ts) ignores HTTP header routing', () => {
  /**
   * Builds a fake Express request/response pair for createContext.
   *
   * @param headers - Raw headers of the simulated request.
   * @returns A {req, res} pair, loosely typed like Express would produce.
   */
  const fakeReqRes = (headers: Record<string, string> = {}): { req: Request; res: Response } => ({
    req: { headers } as unknown as Request,
    res: {} as unknown as Response,
  });

  test('the context never carries a catalog/schema resolved from headers', async () => {
    const { req, res } = fakeReqRes({ 'x-catalog-id': 'macroeconomics', 'x-schema-id': 'trade' });
    const context = await createContext({ req, res });

    expect(context).not.toHaveProperty('requestCatalog');
    expect(context).not.toHaveProperty('requestSchema');
  });

  test('getLoadersForCatalog(null, null) resolves identically with or without the header', async () => {
    const withHeader = await createContext({
      ...fakeReqRes({ 'x-catalog-id': 'macroeconomics', 'x-schema-id': 'trade' }),
    });
    const withoutHeader = await createContext(fakeReqRes());

    // Aucun argument explicite : les deux réutilisent les loaders par défaut,
    // que l'en-tête x-catalog-id désigne ou non un autre catalogue valide.
    expect(withHeader.getLoadersForCatalog(null, null)).toBeNull();
    expect(withoutHeader.getLoadersForCatalog(null, null)).toBeNull();
  });

  test('only the explicit `catalog` argument routes to a non-default catalog', async () => {
    const { req, res } = fakeReqRes({ 'x-catalog-id': 'default' });
    const context: ServerContext = await createContext({ req, res });

    // L'en-tête vaut 'default' (le défaut) ; l'argument cible explicitement 'macroeconomics'
    expect(context.getLoadersForCatalog('macroeconomics', null)).not.toBeNull();
  });
});
