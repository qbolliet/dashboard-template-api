/**
 * Integration tests for the query-complexity guard.
 *
 * Two concerns are covered: the Apollo plugin wiring (an over-budget query is
 * rejected in didResolveOperation, before any resolver runs) and the
 * calibration of SECURITY.COMPLEXITY.MAX_ALLOWED in config/security.yaml
 * against the queries the dashboard actually sends.
 */

import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { ApolloServer } from '@apollo/server';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { parse } from 'graphql';
import type { DocumentNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { SecurityManager } from '../../src/security/manager.js';
import { QueryComplexityAnalyzer } from '../../src/security/complexity-analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Complexity section of config/security.yaml. */
interface ComplexityYaml {
  MAX_ALLOWED: number;
  SCALAR_COST: number;
  OBJECT_COST: number;
  LIST_FACTOR: number;
  DEPTH_FACTOR: number;
  INTROSPECTION_COST: number;
  CUSTOM_SCORES: Record<string, number>;
}

// ─── Configuration réelle ────────────────────────────────────────────────────

// Lecture du YAML livré — les surcharges de config/test/ ne doivent pas masquer
// le calibrage effectif du plafond de production.
const securityYaml = YAML.parse(
  fs.readFileSync(path.resolve(__dirname, '../../config/security.yaml'), 'utf8'),
) as { SECURITY: { COMPLEXITY: ComplexityYaml } };
const complexityConfig = securityYaml.SECURITY.COMPLEXITY;

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/**
 * Splits a document into its first operation and its named fragments.
 *
 * @param source - GraphQL document source.
 * @returns The operation definition and the fragment map.
 */
const parseOperation = (
  source: string,
): { operation: OperationDefinitionNode; fragments: Record<string, FragmentDefinitionNode> } => {
  const document: DocumentNode = parse(source);
  const fragments: Record<string, FragmentDefinitionNode> = {};
  let operation: OperationDefinitionNode | undefined;

  for (const definition of document.definitions) {
    if (definition.kind === 'FragmentDefinition') {
      fragments[definition.name.value] = definition;
    } else if (definition.kind === 'OperationDefinition' && !operation) {
      operation = definition;
    }
  }
  return { operation: operation as OperationDefinitionNode, fragments };
};

// Requêtes représentatives du dashboard (tableau, graphique, menus, métadonnées)
const REALISTIC_QUERIES: Record<string, string> = {
  table: `{
    getFactTableWithMetadata(limit: 100, structuredFilters: {}, sort: []) {
      columns
      data
      metadata { count extents total hasNextPage currentPage totalPages generatedAt }
    }
  }`,
  facts: `{
    getFactTable(limit: 100, structuredFilters: {}, sort: []) {
      keys { name value }
      measures { name value }
    }
  }`,
  chart: `{
    getAggregatedFacts(limit: 100, structuredFilters: {}, sort: []) {
      groupByValue
      value
      count
    }
  }`,
  fullPage: `{
    table: getFactTableWithMetadata(limit: 100, structuredFilters: {}, sort: []) {
      columns
      data
      metadata { count extents total hasNextPage currentPage totalPages generatedAt }
    }
    chart: getAggregatedFacts(limit: 100, structuredFilters: {}) { groupByValue value count }
    options: getSelectOptions { value label }
    meta: getCatalogs { name schemas { name fields { name label sqlType unit displayFormat family } } }
  }`,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Calibrage de MAX_ALLOWED (config/security.yaml)', () => {
  const analyzer = new QueryComplexityAnalyzer(
    complexityConfig as unknown as Record<string, unknown>,
  );

  test.each(Object.entries(REALISTIC_QUERIES))(
    'la requête « %s » reste sous le tiers du plafond',
    (_name, source) => {
      const { operation, fragments } = parseOperation(source);
      const score = analyzer.calculateForOperation(operation, fragments, {});

      // Marge d'au moins 3x : une requête légitime ne doit jamais frôler le plafond
      expect(score).toBeLessThanOrEqual(complexityConfig.MAX_ALLOWED / 3);
    },
  );

  test('une requête pathologiquement imbriquée dépasse le plafond', () => {
    // Arbre large et profond — le cas que le plafond doit effectivement arrêter
    const leaves = Array.from(
      { length: 12 },
      (_unused, i) => `f${i} { g { h { i { j { k { value } } } } } }`,
    );
    const source = `{ ${leaves.join(' ')} }`;
    const { operation, fragments } = parseOperation(source);

    expect(analyzer.calculateForOperation(operation, fragments, {})).toBeGreaterThan(
      complexityConfig.MAX_ALLOWED,
    );
  });
});

describe('Branchement Apollo du garde de complexité', () => {
  let server: ApolloServer;
  let securityManager: SecurityManager;
  const resolverSpy = jest.fn(() => 'ok');

  beforeAll(async () => {
    // Plafond volontairement bas pour éprouver le rejet sans requête géante
    securityManager = new SecurityManager({
      RATE_LIMIT: { MAX_REQUESTS: 1000, WINDOW_MS: 60000 },
      COMPLEXITY: { ...complexityConfig, MAX_ALLOWED: 2 },
    } as never);

    const schema = makeExecutableSchema({
      typeDefs: `
        type Nested { deep: Nested, value: String }
        type Query { cheap: String, nested: Nested }
      `,
      resolvers: {
        Query: {
          cheap: (): string => resolverSpy(),
          nested: (): Record<string, unknown> => ({ value: resolverSpy() }),
        },
      },
    });

    // Reproduction du hook de src/server.ts (didResolveOperation)
    server = new ApolloServer({
      schema,
      plugins: [
        {
          async requestDidStart() {
            return {
              async didResolveOperation({ document, operation, request }) {
                if (operation) {
                  securityManager.validateComplexity(
                    document,
                    operation,
                    (request.variables ?? {}) as Record<string, unknown>,
                    {},
                  );
                }
              },
            };
          },
        },
      ],
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    await securityManager.cleanup();
  });

  test('accepte une requête sous le plafond', async () => {
    const response = await server.executeOperation({ query: '{ cheap }' });
    const result = response.body.kind === 'single' ? response.body.singleResult : null;
    expect(result?.errors).toBeUndefined();
    expect(result?.data).toEqual({ cheap: 'ok' });
  });

  test('rejette une requête trop complexe avant tout resolver', async () => {
    resolverSpy.mockClear();

    const response = await server.executeOperation({
      query: '{ nested { deep { deep { deep { value } } } } }',
    });
    const result = response.body.kind === 'single' ? response.body.singleResult : null;

    expect(result?.errors?.[0]?.extensions?.code).toBe('QUERY_COMPLEXITY_EXCEEDED');
    // Message explicite : score, plafond et piste de correction
    expect(result?.errors?.[0]?.message).toContain('Query too complex');
    expect(result?.errors?.[0]?.message).toContain('exceeds the maximum of 2');
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  test('laisse passer l’introspection malgré son coût dédié', async () => {
    const response = await server.executeOperation({ query: '{ __schema { types { name } } }' });
    const result = response.body.kind === 'single' ? response.body.singleResult : null;
    expect(result?.errors).toBeUndefined();
  });
});
