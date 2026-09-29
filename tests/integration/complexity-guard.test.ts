/**
 * Integration tests for the query-complexity guard.
 *
 * Three concerns are covered: the Apollo plugin wiring (an over-budget query is
 * rejected in didResolveOperation, before any resolver runs), the calibration
 * of SECURITY.COMPLEXITY in config/security.yaml against the queries the
 * dashboard actually sends, and the abusive shapes the scale must refuse
 * (aliases, stats over a whole catalog, large limits). The operations are
 * scored against the published SDL (schema.graphql), whose `limit` defaults
 * are charged when the argument is omitted.
 */

import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { ApolloServer } from '@apollo/server';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { buildSchema, parse } from 'graphql';
import type { DocumentNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { SecurityManager } from '../../src/security/manager.js';
import { QueryComplexityAnalyzer } from '../../src/security/complexity-analyzer.js';
import type { ColumnCounter } from '../../src/security/complexity-analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Complexity section of config/security.yaml. */
interface ComplexityYaml {
  MAX_ALLOWED: number;
  MAX_ROOT_FIELDS: number;
  SCALAR_COST: number;
  OBJECT_COST: number;
  DEPTH_FACTOR: number;
  INTROSPECTION_COST: number;
  ROW_COST: number;
  STATS_COST_PER_COLUMN: number;
  DEFAULT_ROOT_FIELD_SCORE: number;
  ROOT_FIELD_SCORES: Record<string, number>;
}

// ─── Configuration réelle ────────────────────────────────────────────────────

// Lecture du YAML livré — les surcharges de config/test/ ne doivent pas masquer
// le calibrage effectif du plafond de production.
const securityYaml = YAML.parse(
  fs.readFileSync(path.resolve(__dirname, '../../config/security.yaml'), 'utf8'),
) as { SECURITY: { COMPLEXITY: ComplexityYaml } };
const complexityConfig = securityYaml.SECURITY.COMPLEXITY;

// SDL publié : défauts de `limit` et liste des champs racine
const publishedSchema = buildSchema(
  fs.readFileSync(path.resolve(__dirname, '../../schema.graphql'), 'utf8'),
);

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/**
 * Builds a column counter answering fixed counts.
 *
 * @param perSchema - Columns of any single schema.
 * @param all - Columns of every schema of every catalog.
 * @returns The counter.
 */
const fixedColumns = (perSchema: number, all: number = perSchema): ColumnCounter => ({
  columnsOf: async () => perSchema,
  allColumns: async () => all,
});

/**
 * Repeats an aliased root field.
 *
 * @param count - Number of aliases.
 * @param field - Field with its arguments and selection.
 * @returns The operation source.
 */
const aliased = (count: number, field: string): string =>
  `{ ${Array.from({ length: count }, (_unused, i) => `a${i}: ${field}`).join(' ')} }`;

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
  // Bornes des sliders/datepickers : une requête SQL par colonne, filtres courants compris
  sliderRanges: `{
    price: getFieldStats(fieldName: "value", structuredFilters: {}) { min max }
    date: getFieldStats(fieldName: "date", structuredFilters: {}) { min max }
    horizon: getFieldStats(fieldName: "horizon", structuredFilters: {}) { min max distinctCount nullCount }
  }`,
  fullPage: `{
    table: getFactTableWithMetadata(limit: 100, structuredFilters: {}, sort: []) {
      columns
      data
      metadata { count extents total hasNextPage currentPage totalPages generatedAt }
    }
    chart: getAggregatedFacts(limit: 100, structuredFilters: {}) { groupByValue value count }
    options: getSelectOptions { value label }
    tree: getSelectOptionsTree(fieldName: "commune", maxDepth: 2)
    meta: getCatalogs { name schemas { name fields { name label sqlType unit displayFormat family } } }
  }`,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Barème de complexité (config/security.yaml)', () => {
  const analyzer = new QueryComplexityAnalyzer(
    complexityConfig as unknown as Record<string, unknown>,
  );

  /**
   * Scores a query against the shipped scale and the published SDL.
   *
   * @param source - GraphQL document source.
   * @param columns - Column counter (16 columns, the test `main` schema, by default).
   * @returns The complexity score.
   */
  const score = (source: string, columns: ColumnCounter = fixedColumns(16)): Promise<number> => {
    const { operation, fragments } = parseOperation(source);
    return analyzer.calculateForOperation(
      operation,
      fragments,
      {},
      {
        schema: publishedSchema,
        columns,
      },
    );
  };

  /**
   * Counts the root fields of a query.
   *
   * @param source - GraphQL document source.
   * @returns Number of data root fields.
   */
  const rootFields = (source: string): number => {
    const { operation, fragments } = parseOperation(source);
    return analyzer.countRootFields(operation, fragments);
  };

  test('chaque champ de Query a une entrée dans ROOT_FIELD_SCORES', () => {
    const queryFields = Object.keys(publishedSchema.getQueryType()?.getFields() ?? {});
    const missing = queryFields.filter((name) => !(name in complexityConfig.ROOT_FIELD_SCORES));
    expect(missing).toEqual([]);
    // Aucune entrée orpheline : chaque score désigne un champ réel
    const orphans = Object.keys(complexityConfig.ROOT_FIELD_SCORES).filter(
      (name) => !queryFields.includes(name),
    );
    expect(orphans).toEqual([]);
  });

  test('le score par défaut d’un champ racine n’est jamais nul', () => {
    expect(complexityConfig.DEFAULT_ROOT_FIELD_SCORE).toBeGreaterThan(0);
    expect(Object.values(complexityConfig.ROOT_FIELD_SCORES).every((s) => s > 0)).toBe(true);
  });

  describe('requêtes du dashboard', () => {
    test.each(Object.entries(REALISTIC_QUERIES))(
      'la requête « %s » reste sous le tiers du plafond',
      async (_name, source) => {
        // Marge d'au moins 3x : une requête légitime ne doit jamais frôler le plafond
        expect(await score(source)).toBeLessThanOrEqual(complexityConfig.MAX_ALLOWED / 3);
        expect(rootFields(source)).toBeLessThanOrEqual(complexityConfig.MAX_ROOT_FIELDS);
      },
    );

    test('les colonnes et leurs bornes d’un schéma de 16 colonnes restent sous la moitié du plafond', async () => {
      // `stats` sur tout un schéma : le chemin coûteux (une requête SQL par colonne)
      const source = `{
        getCatalogSchema { name label sqlType unit displayFormat stats { min max distinctCount nullCount } }
      }`;
      expect(await score(source)).toBeLessThanOrEqual(complexityConfig.MAX_ALLOWED / 2);
    });

    test('une page de 1 000 lignes reste sous le plafond', async () => {
      expect(
        await score('{ getFactTableWithMetadata(limit: 1000) { columns data } }'),
      ).toBeLessThanOrEqual(complexityConfig.MAX_ALLOWED);
    });

    test('getSelectOptions(limit: 1000000) passe le garde pour recevoir le BAD_USER_INPUT du resolver', async () => {
      const source = '{ getSelectOptions(fieldName: "country", limit: 1000000) { value } }';
      expect(await score(source)).toBeLessThanOrEqual(complexityConfig.MAX_ALLOWED);
    });
  });

  describe('formes abusives refusées', () => {
    test('50 alias de compareFacts dépassent le plafond de champs racine et de score', async () => {
      const source = aliased(
        50,
        'compareFacts(catalogA: "default", catalogB: "macroeconomics", joinFields: ["country"]) { total }',
      );
      expect(rootFields(source)).toBeGreaterThan(complexityConfig.MAX_ROOT_FIELDS);
      expect(await score(source)).toBeGreaterThan(complexityConfig.MAX_ALLOWED);
    });

    test('40 alias de getFieldStats dépassent le plafond de champs racine', () => {
      const source = aliased(40, 'getFieldStats(fieldName: "value") { min max }');
      expect(rootFields(source)).toBeGreaterThan(complexityConfig.MAX_ROOT_FIELDS);
    });

    test('getCatalogSchema { stats } sur 40 colonnes dépasse le plafond, 39 non', async () => {
      const source = '{ getCatalogSchema { name stats { min max } } }';
      expect(await score(source, fixedColumns(40))).toBeGreaterThan(complexityConfig.MAX_ALLOWED);
      expect(await score(source, fixedColumns(39))).toBeLessThanOrEqual(
        complexityConfig.MAX_ALLOWED,
      );
    });

    test('stats sur toutes les colonnes de tous les catalogues dépasse le plafond', async () => {
      const source = '{ getCatalogs { schemas { fields { name stats { min } } } } }';
      expect(await score(source, fixedColumns(16, 60))).toBeGreaterThan(
        complexityConfig.MAX_ALLOWED,
      );
    });

    test('20 alias de getAggregatedFactsWithMetadata(limit: 1000) dépassent le plafond', async () => {
      const source = aliased(
        20,
        'getAggregatedFactsWithMetadata(groupBy: "country", measure: "value", limit: 1000) { data { key } }',
      );
      expect(rootFields(source)).toBeLessThanOrEqual(complexityConfig.MAX_ROOT_FIELDS);
      expect(await score(source)).toBeGreaterThan(complexityConfig.MAX_ALLOWED);
    });

    test('un limit omis est facturé à sa valeur par défaut du SDL', async () => {
      expect(await score('{ getFactTable { total } }')).toBeCloseTo(
        await score('{ getFactTable(limit: 100) { total } }'),
      );
    });

    test('une requête pathologiquement imbriquée dépasse le plafond', async () => {
      // Arbre large et profond — le cas que le plafond doit effectivement arrêter
      const leaves = Array.from(
        { length: 12 },
        (_unused, i) => `f${i} { g { h { i { j { k { value } } } } } }`,
      );
      expect(await score(`{ ${leaves.join(' ')} }`)).toBeGreaterThan(complexityConfig.MAX_ALLOWED);
    });
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
      COMPLEXITY: {
        ...complexityConfig,
        MAX_ALLOWED: 5,
        ROOT_FIELD_SCORES: { cheap: 1, nested: 1 },
      },
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
                  await securityManager.validateComplexity(
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
    expect(result?.errors?.[0]?.message).toContain('exceeds the maximum of 5');
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  test('laisse passer l’introspection malgré son coût dédié', async () => {
    const response = await server.executeOperation({ query: '{ __schema { types { name } } }' });
    const result = response.body.kind === 'single' ? response.body.singleResult : null;
    expect(result?.errors).toBeUndefined();
  });
});
