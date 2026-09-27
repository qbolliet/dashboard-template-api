/**
 * HTTP integration tests of the /graphql pipeline as wired in src/server.ts.
 *
 * Drives the real Apollo server (createApolloServer), the real schema and the
 * real body-limit middleware (applyRequestLimits) with supertest, against the
 * test DuckLake catalog (npm run test:setup). Covers the three defects that
 * blocked the merge: GraphQL validation silently disabled by a custom rule,
 * request size limits rejecting legitimate filter trees (and answering 403),
 * and the complexity analyzer crashing on omitted variables with a default.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { expressMiddleware } from '@as-integrations/express5';
import type { ApolloServer } from '@apollo/server';
import { ensureSetup } from '../unit/test_schema/test_resolvers/helpers.js';
import { createApolloServer, createContext } from '../../src/server.js';
import type { ServerContext, ServerMetrics } from '../../src/server.js';
import { SecurityManager } from '../../src/security/manager.js';
import { applyRequestLimits } from '../../src/security/request-limits.js';
import { config } from '../../src/utils/config-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Test application plus the handles needed for cleanup. */
interface TestApp {
  app: Express;
  server: ApolloServer<ServerContext>;
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/**
 * Builds an Express app wired like src/server.ts for the /graphql route.
 *
 * @param introspection - Overrides API.GRAPHQL.INTROSPECTION when provided.
 * @returns The app and its started Apollo server.
 */
const buildApp = async (introspection?: boolean): Promise<TestApp> => {
  const metrics: ServerMetrics = {
    startedAt: new Date().toISOString(),
    requests: { total: 0, errors: 0 },
    responseTimes: [],
    maxStoredTimes: 1000,
  };
  const server = createApolloServer(new SecurityManager(config.SECURITY), metrics, {
    introspection,
  });
  await server.start();

  const app = express();
  applyRequestLimits(app);
  app.use('/graphql', expressMiddleware(server, { context: createContext }));
  return { app, server };
};

/**
 * Builds a filter tree leaf.
 *
 * @param variable - Column name.
 * @param operation - FilterOperation value.
 * @param value - Criterion value.
 * @param connector - Connector with the previous node.
 * @returns FilterNode leaf object.
 */
const leaf = (variable: string, operation: string, value: unknown, connector?: 'AND' | 'OR') => ({
  ...(connector ? { connector } : {}),
  criterion: { variable, operation, value },
});

/**
 * Extracts the first error code of a GraphQL response body.
 *
 * @param body - Parsed response body.
 * @returns The `extensions.code` of the first error, if any.
 */
const firstCode = (body: {
  errors?: Array<{ extensions?: { code?: string } }>;
}): string | undefined => body.errors?.[0]?.extensions?.code;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('/graphql (câblage de src/server.ts)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    await ensureSetup();
    testApp = await buildApp();
  });

  afterAll(async () => {
    await testApp.server.stop();
  });

  const post = (body: Record<string, unknown>) => request(testApp.app).post('/graphql').send(body);

  describe('B1 — validation GraphQL', () => {
    test('rejects an unknown field with 400 GRAPHQL_VALIDATION_FAILED', async () => {
      const response = await post({ query: '{ getCatalogs { idd } }' });
      expect(response.status).toBe(400);
      expect(firstCode(response.body)).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    test('rejects an unknown argument', async () => {
      const response = await post({ query: '{ getCatalogs(nope: 1) { name } }' });
      expect(response.status).toBe(400);
      expect(firstCode(response.body)).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    test('rejects a missing selection on an object field', async () => {
      const response = await post({ query: '{ getCatalogs }' });
      expect(response.status).toBe(400);
      expect(firstCode(response.body)).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    test('rejects an unknown fragment', async () => {
      const response = await post({ query: '{ getCatalogs { ...Nope } }' });
      expect(response.status).toBe(400);
      expect(firstCode(response.body)).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    test('does not exempt an operation named IntrospectionQuery', async () => {
      const response = await post({
        operationName: 'IntrospectionQuery',
        query: 'query IntrospectionQuery { getCatalogs { idd } }',
      });
      expect(response.status).toBe(400);
      expect(firstCode(response.body)).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    test('still executes a valid query', async () => {
      const response = await post({ query: '{ getCatalogs { id } }' });
      expect(response.status).toBe(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.getCatalogs.length).toBeGreaterThan(0);
    });
  });

  describe('B1 — introspection', () => {
    const introspection = { query: '{ __schema { queryType { name } } }' };

    test('is served when the configuration enables it (development)', async () => {
      const response = await post(introspection);
      expect(response.status).toBe(200);
      expect(response.body.data.__schema.queryType.name).toBe('Query');
    });

    test('is refused by Apollo itself when disabled', async () => {
      const production = await buildApp(false);
      try {
        const response = await request(production.app).post('/graphql').send(introspection);
        expect(response.status).toBe(400);
        expect(firstCode(response.body)).toBe('GRAPHQL_VALIDATION_FAILED');
        expect(response.body.errors[0].message).toMatch(/introspection is not allowed/i);
      } finally {
        await production.server.stop();
      }
    });

    test('is disabled in production by the shipped configuration', () => {
      const apiYaml = YAML.parse(
        fs.readFileSync(path.resolve(__dirname, '../../config/api.yaml'), 'utf8'),
      ) as { API: { GRAPHQL: { INTROSPECTION: { production: boolean } } } };
      expect(apiYaml.API.GRAPHQL.INTROSPECTION.production).toBe(false);
    });
  });

  describe('B4 — limites du corps', () => {
    test('accepts a filter tree of 40 criteria passed as variables', async () => {
      const filters = {
        children: Array.from({ length: 40 }, (_unused, i) =>
          leaf('country', 'EQ', i % 2 === 0 ? 'France' : 'Germany', i === 0 ? undefined : 'OR'),
        ),
      };
      const response = await post({
        query: `query T($f: FilterNode) {
          getFactTable(structuredFilters: $f, limit: 1) { total }
        }`,
        variables: { f: filters },
      });

      // Plus de 50 champs JSON et plusieurs milliers de caractères
      expect(JSON.stringify(filters).length).toBeGreaterThan(1000);
      expect(response.status).toBe(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.getFactTable.total).toEqual(expect.any(Number));
    });

    test('accepts a 5 000-character document', async () => {
      const query = `{ getCatalogs { id } }${' '.repeat(5000)}`;
      const response = await post({ query });
      expect(response.status).toBe(200);
      expect(response.body.errors).toBeUndefined();
    });

    test('rejects a document above MAX_QUERY_SIZE with 400', async () => {
      const query = `{ getCatalogs { id } }${' '.repeat(config.API.REQUEST_LIMITS.MAX_QUERY_SIZE)}`;
      const response = await post({ query });
      expect(response.status).toBe(400);
      expect(firstCode(response.body)).toBe('QUERY_TOO_LARGE');
    });

    test('applies MAX_QUERY_SIZE to an operation named IntrospectionQuery', async () => {
      const query = `query IntrospectionQuery { __typename }${' '.repeat(config.API.REQUEST_LIMITS.MAX_QUERY_SIZE)}`;
      const response = await post({ operationName: 'IntrospectionQuery', query });
      expect(response.status).toBe(400);
      expect(firstCode(response.body)).toBe('QUERY_TOO_LARGE');
    });

    test('rejects an oversized variable string with 400', async () => {
      const response = await post({
        query:
          'query T($s: String) { getSelectOptions(fieldName: "country", searchTerm: $s) { value } }',
        variables: { s: 'x'.repeat(config.API.REQUEST_LIMITS.MAX_FIELD_SIZE + 1) },
      });
      expect(response.status).toBe(400);
      expect(firstCode(response.body)).toBe('VARIABLE_TOO_LARGE');
    });

    test('rejects a body above MAX_REQUEST_SIZE with 400 and an explicit JSON body', async () => {
      // Chaînes courtes : c'est la taille brute du corps qui doit être refusée
      const variables = { values: Array.from({ length: 30_000 }, () => 'abcdefgh') };
      const response = await post({ query: '{ getCatalogs { id } }', variables });

      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(firstCode(response.body)).toBe('REQUEST_BODY_TOO_LARGE');
      expect(response.body.errors[0].message).toContain(config.API.REQUEST_LIMITS.MAX_REQUEST_SIZE);
    });
  });

  describe('AF2 — variables avec valeur par défaut', () => {
    const query = `query A($f: String!, $l: Int = 50) {
      getSelectOptions(fieldName: $f, limit: $l) { value }
    }`;

    test('answers 200 when the variable with a default is omitted', async () => {
      const response = await post({ query, variables: { f: 'country' } });
      expect(response.status).toBe(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.getSelectOptions.length).toBeGreaterThan(0);
    });

    test('answers 200 when the variable is provided', async () => {
      const response = await post({ query, variables: { f: 'country', l: 5 } });
      expect(response.status).toBe(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.getSelectOptions.length).toBeLessThanOrEqual(5);
    });

    test('answers 200 (no 500) when the variable is null', async () => {
      const response = await post({ query, variables: { f: 'country', l: null } });
      expect(response.status).toBe(200);
      expect(firstCode(response.body)).not.toBe('INTERNAL_SERVER_ERROR');
    });
  });
});
