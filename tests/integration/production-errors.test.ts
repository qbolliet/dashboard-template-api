/**
 * HTTP integration tests of /graphql under NODE_ENV=production.
 *
 * NODE_ENV is set before any application module is loaded (dynamic imports
 * below: static imports would be evaluated first), so the configuration is
 * the production one — introspection off, production depth limit, error
 * masking. The app is wired like src/server.ts (real Apollo server, schema,
 * security manager and body limits) against the test DuckLake catalog
 * (npm run test:setup).
 *
 * Covers the acceptance criteria of the security scoring fix: no text
 * pattern rejects legitimate queries (`__typename`, a search for
 * "ecosystem", a column named "mutation_rate"), client errors keep a
 * readable message in production, the complexity scale refuses abusive
 * shapes, and every error is logged exactly once under its errorId.
 */

import { jest, describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import request from 'supertest';
import type { Express } from 'express';
import type { ApolloServer } from '@apollo/server';
import type { ServerContext, ServerMetrics } from '../../src/server.js';

// Environnement de production, fixé avant le chargement de la configuration
process.env.NODE_ENV = 'production';

const express = (await import('express')).default;
const { expressMiddleware } = await import('@as-integrations/express5');
const { ensureSetup } = await import('../unit/test_schema/test_resolvers/helpers.js');
const { createApolloServer, createContext } = await import('../../src/server.js');
const { SecurityManager } = await import('../../src/security/manager.js');
const { applyRequestLimits } = await import('../../src/security/request-limits.js');
const { config } = await import('../../src/utils/config-loader.js');
const { logger } = await import('../../src/utils/logger.js');

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** GraphQL error as found in a response body. */
interface ResponseError {
  message: string;
  extensions?: { code?: string; errorId?: string; [key: string]: unknown };
}

/** GraphQL response body. */
interface ResponseBody {
  data?: Record<string, unknown> | null;
  errors?: ResponseError[];
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/**
 * Repeats an aliased root field.
 *
 * @param count - Number of aliases.
 * @param field - Field with its arguments and selection.
 * @returns The operation source.
 */
const aliased = (count: number, field: string): string =>
  `{ ${Array.from({ length: count }, (_unused, i) => `a${i}: ${field}`).join(' ')} }`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('/graphql en production', () => {
  let app: Express;
  let server: ApolloServer<ServerContext>;

  beforeAll(async () => {
    await ensureSetup();

    const metrics: ServerMetrics = {
      startedAt: new Date().toISOString(),
      requests: { total: 0, errors: 0 },
      responseTimes: [],
      maxStoredTimes: 1000,
    };
    server = createApolloServer(new SecurityManager(config.SECURITY), metrics);
    await server.start();

    app = express();
    applyRequestLimits(app);
    app.use('/graphql', expressMiddleware(server, { context: createContext }));
  });

  afterAll(async () => {
    await server.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Posts a GraphQL query.
   *
   * @param query - Operation source.
   * @param variables - Operation variables.
   * @returns HTTP status and parsed body.
   */
  const post = async (
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ status: number; body: ResponseBody }> => {
    const response = await request(app).post('/graphql').send({ query, variables });
    return { status: response.status, body: response.body as ResponseBody };
  };

  test('runs with the production configuration', () => {
    expect(config.ENVIRONMENT).toBe('production');
    expect(config.API.GRAPHQL.INTROSPECTION).toBe(false);
  });

  describe('plus aucun motif appliqué au texte de la requête', () => {
    test('{ getCatalogs { id __typename } } → 200', async () => {
      const { status, body } = await post('{ getCatalogs { id __typename } }');
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const catalogs = body.data?.['getCatalogs'] as Array<{ __typename: string }>;
      expect(catalogs.length).toBeGreaterThan(0);
      expect(catalogs[0]?.__typename).toBe('Catalog');
    });

    test('searchTerm "ecosystem" → 200', async () => {
      const { status, body } = await post(
        '{ getSelectOptions(fieldName: "notes", searchTerm: "ecosystem") { value } }',
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect(body.data?.['getSelectOptions']).toEqual(expect.any(Array));
    });

    test('a column named "mutation_rate" gets a readable BAD_USER_INPUT', async () => {
      const { body } = await post(
        '{ getFactTable(fields: ["mutation_rate"], limit: 1) { total } }',
      );
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors?.[0]?.message).toContain('mutation_rate');
    });

    test('a mutation is refused by the operation-type check, with its message', async () => {
      const { status, body } = await post('mutation { getCatalogs { id } }');
      expect(status).toBe(400);
      expect(body.errors?.[0]?.extensions?.code).toBe('OPERATION_TYPE_NOT_ALLOWED');
      expect(body.errors?.[0]?.message).toBe('Only queries are allowed, got mutation');
    });

    test('introspection is refused by Apollo (introspection: false)', async () => {
      const { status, body } = await post('{ __schema { queryType { name } } }');
      expect(status).toBe(400);
      expect(body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
      expect(body.errors?.[0]?.message).toMatch(/introspection is not allowed/i);
    });
  });

  describe('messages lisibles des erreurs client', () => {
    test('filter on an unknown column → BAD_USER_INPUT naming the column', async () => {
      const { status, body } = await post(
        `query F($f: FilterNode) { getFactTable(structuredFilters: $f, limit: 1) { total } }`,
        {
          f: { children: [{ criterion: { variable: 'nope_column', operation: 'EQ', value: 1 } }] },
        },
      );
      expect(status).toBe(200);
      const error = body.errors?.[0];
      expect(error?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(error?.message).toContain('nope_column');
      expect(error?.extensions?.errorId).toEqual(expect.any(String));
    });

    test('getSelectOptions(limit: 1000000) → BAD_USER_INPUT', async () => {
      const { body } = await post(
        '{ getSelectOptions(fieldName: "country", limit: 1000000) { value } }',
      );
      const error = body.errors?.[0];
      expect(error?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(error?.message).toContain(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
    });

    test('an unknown catalog → BAD_USER_INPUT naming it', async () => {
      const { body } = await post('{ getCatalogSchema(catalog: "nope") { name } }');
      const error = body.errors?.[0];
      expect(error?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(error?.message).toContain("Catalog 'nope' is not available");
    });
  });

  describe('barème de complexité', () => {
    test('50 aliased compareFacts → QUERY_COMPLEXITY_EXCEEDED (HTTP 400)', async () => {
      const { status, body } = await post(
        aliased(
          50,
          'compareFacts(catalogA: "default", catalogB: "macroeconomics", joinFields: ["country"]) { total }',
        ),
      );
      expect(status).toBe(400);
      const error = body.errors?.[0];
      expect(error?.extensions?.code).toBe('QUERY_COMPLEXITY_EXCEEDED');
      expect(error?.message).toContain('root fields exceed the maximum');
      expect(body.data).toBeUndefined();
    });

    test('stats on every column of every catalog → QUERY_COMPLEXITY_EXCEEDED', async () => {
      const { status, body } = await post(
        '{ getCatalogs { schemas { fields { name stats { min max } } } } }',
      );
      expect(status).toBe(400);
      const error = body.errors?.[0];
      expect(error?.extensions?.code).toBe('QUERY_COMPLEXITY_EXCEEDED');
      expect(error?.message).toContain('exceeds the maximum of');
      expect(error?.extensions?.['complexity']).toBeGreaterThan(
        config.SECURITY.COMPLEXITY.MAX_ALLOWED,
      );
    });

    test('stats on the columns of one schema stays within budget', async () => {
      const { status, body } = await post(
        '{ getCatalogSchema(schema: "main") { name stats { min max } } }',
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect((body.data?.['getCatalogSchema'] as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe('journalisation unique', () => {
    test('a client error is logged once, under the errorId sent to the client', async () => {
      const warn = jest.spyOn(logger, 'warn');
      const error = jest.spyOn(logger, 'error');

      const { body } = await post(
        '{ getSelectOptions(fieldName: "country", limit: 1000000) { value } }',
      );
      const errorId = body.errors?.[0]?.extensions?.errorId;
      expect(errorId).toEqual(expect.any(String));

      // Toutes les entrées de journal portant cet identifiant
      const entries = [...warn.mock.calls, ...error.mock.calls].filter((call) =>
        call.some(
          (argument) =>
            typeof argument === 'object' &&
            argument !== null &&
            (argument as Record<string, unknown>)['errorId'] === errorId,
        ),
      );
      expect(entries).toHaveLength(1);
      expect(error).not.toHaveBeenCalled();
    });
  });
});
