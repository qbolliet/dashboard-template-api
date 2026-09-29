/**
 * Unit tests for QueryComplexityAnalyzer (src/security/complexity-analyzer.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger to isolate the analyzer logic.
 * Covers the scoring scale: a score for every root field (non-zero default),
 * rows requested through `limit` (bounded by MAX_LIMIT, SDL default when
 * omitted), `Metadata.stats` priced per column, free `__typename`, the root
 * field count, fragments, arguments and extractNumericValue.
 */

import { jest } from '@jest/globals';
import { buildSchema, parse } from 'graphql';
import type {
  DocumentNode,
  FragmentDefinitionNode,
  GraphQLSchema,
  OperationDefinitionNode,
} from 'graphql';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration mockée de la section API (bornes de pagination). */
interface MockConfig {
  API: { PAGINATION: { DEFAULT_LIMIT: number; MAX_LIMIT: number } };
}

/** Logger contextuel mocké — quatre méthodes de journalisation. */
interface MockLogger {
  security: jest.Mock;
  operation: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

/** Compteur de colonnes injecté dans l'analyseur. */
interface ColumnCounterStub {
  columnsOf: jest.Mock<(catalog: unknown, schema: unknown) => Promise<number>>;
  allColumns: jest.Mock<() => Promise<number>>;
}

/** Options de score acceptées par calculateForOperation. */
interface ScoringOptions {
  schema?: GraphQLSchema;
  columns?: ColumnCounterStub;
}

/** Interface publique d'une instance de QueryComplexityAnalyzer. */
interface QueryComplexityAnalyzerInstance {
  calculateForOperation: (
    operation: OperationDefinitionNode,
    fragments?: Record<string, FragmentDefinitionNode>,
    variables?: Record<string, unknown>,
    options?: ScoringOptions,
  ) => Promise<number>;
  countRootFields: (
    operation: OperationDefinitionNode,
    fragments?: Record<string, FragmentDefinitionNode>,
  ) => number;
  maxAllowed: number;
  maxRootFields: number;
  extractNumericValue: (node: unknown) => number;
}

/** Constructeur de QueryComplexityAnalyzer. */
interface QueryComplexityAnalyzerConstructor {
  new (config: Record<string, unknown>): QueryComplexityAnalyzerInstance;
}

// ─── Configuration mockée ─────────────────────────────────────────────────────

const mockConfig: MockConfig = {
  API: { PAGINATION: { DEFAULT_LIMIT: 100, MAX_LIMIT: 1000 } },
};

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: (): MockLogger => ({
    security: jest.fn(),
    operation: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Barème de test : coûts ronds pour des scores calculables à la main
const TEST_SCALE: Record<string, unknown> = {
  MAX_ALLOWED: 1000,
  MAX_ROOT_FIELDS: 20,
  SCALAR_COST: 0,
  OBJECT_COST: 1,
  DEPTH_FACTOR: 2,
  INTROSPECTION_COST: 100,
  ROW_COST: 0.1,
  STATS_COST_PER_COLUMN: 5,
  DEFAULT_ROOT_FIELD_SCORE: 5,
  ROOT_FIELD_SCORES: {
    cheap: 1,
    items: 1,
    heavy: 50,
    getCatalogs: 1,
    getCatalogSchema: 2,
    getFactTableWithMetadata: 8,
  },
};

// Schéma minimal portant des défauts SDL de `limit`
const LIMIT_SCHEMA = buildSchema(`
  type Query {
    paged(limit: Int! = 100): [Int]
    options(limit: Int = 50): [Int]
    plain: Int
  }
`);

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/**
 * Parses a query string into the pieces the analyzer expects.
 *
 * @param source - GraphQL document source.
 * @returns The first operation definition and its named fragments.
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

/**
 * Builds a column counter stub.
 *
 * @param perSchema - Columns returned by columnsOf.
 * @param all - Columns returned by allColumns.
 * @returns The stub, with spies.
 */
const counter = (perSchema: number, all: number = perSchema): ColumnCounterStub => ({
  columnsOf: jest.fn(async () => perSchema),
  allColumns: jest.fn(async () => all),
});

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertion d'assignation définitive — assigné dans beforeAll avant tout test.
let QueryComplexityAnalyzer!: QueryComplexityAnalyzerConstructor;

beforeAll(async () => {
  ({ QueryComplexityAnalyzer } = (await import('../../../src/security/complexity-analyzer.js')) as {
    QueryComplexityAnalyzer: QueryComplexityAnalyzerConstructor;
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QueryComplexityAnalyzer', () => {
  let analyzer!: QueryComplexityAnalyzerInstance;

  /**
   * Scores a query source with the analyzer under test.
   *
   * @param source - GraphQL document source.
   * @param variables - Optional variable values.
   * @param options - Optional schema and column counter.
   * @returns The complexity score of the first operation.
   */
  const score = (
    source: string,
    variables: Record<string, unknown> = {},
    options: ScoringOptions = {},
  ): Promise<number> => {
    const { operation, fragments } = parseOperation(source);
    return analyzer.calculateForOperation(operation, fragments, variables, options);
  };

  /**
   * Counts the root fields of a query source.
   *
   * @param source - GraphQL document source.
   * @returns Number of data root fields.
   */
  const rootFields = (source: string): number => {
    const { operation, fragments } = parseOperation(source);
    return analyzer.countRootFields(operation, fragments);
  };

  beforeEach(() => {
    analyzer = new QueryComplexityAnalyzer(TEST_SCALE);
  });

  describe('configuration', () => {
    test('exposes the configured ceilings', () => {
      expect(analyzer.maxAllowed).toBe(1000);
      expect(analyzer.maxRootFields).toBe(20);
    });

    test('falls back to the shipped defaults', () => {
      const defaults = new QueryComplexityAnalyzer({});
      expect(defaults.maxAllowed).toBe(200);
      expect(defaults.maxRootFields).toBe(20);
    });
  });

  describe('root fields', () => {
    test('charges the configured score of a root field', async () => {
      expect(await score('{ cheap }')).toBe(1);
      expect(await score('{ heavy { id } }')).toBe(50);
    });

    test('charges a non-zero default to a root field missing from the table', async () => {
      expect(await score('{ unlisted }')).toBe(5);
      expect(await score('{ unlisted { id } }')).toBe(5);
    });

    test('sums every root field, aliases included', async () => {
      expect(await score('{ a: heavy { id } b: heavy { id } c: cheap }')).toBe(101);
    });

    test('scores the root fields carried by fragments at the root', async () => {
      expect(await score('{ ...F } fragment F on Query { heavy { id } }')).toBe(50);
      expect(await score('{ ... on Query { heavy { id } cheap } }')).toBe(51);
    });

    test('ignores unknown or cyclic fragment spreads instead of throwing', async () => {
      expect(await score('{ cheap ...Missing }')).toBe(1);
      expect(await score('{ ...F } fragment F on Query { cheap ...F }')).toBe(1);
    });
  });

  describe('nested fields', () => {
    test('charges OBJECT_COST times DEPTH_FACTOR^depth, leaves being free', async () => {
      // Racine (1) + enfant objet à la profondeur 1 (1 * 2^1), feuilles gratuites
      expect(await score('{ cheap { a { b } } }')).toBe(3);
      // Profondeur 2 : 1 * 2^2 de plus
      expect(await score('{ cheap { a { b { c } } } }')).toBe(7);
    });

    test('expands named fragments without depth inflation', async () => {
      const withFragment = await score(`
        { cheap { ...Inner } }
        fragment Inner on Thing { b { c } }
      `);
      expect(withFragment).toBe(await score('{ cheap { b { c } } }'));
    });
  });

  describe('meta fields', () => {
    test('__typename is free, at the root and nested', async () => {
      expect(await score('{ __typename cheap }')).toBe(1);
      expect(await score('{ cheap { __typename a { __typename } } }')).toBe(3);
    });

    test('__schema and __type carry the introspection cost', async () => {
      expect(await score('{ __schema { types { name } } }')).toBeGreaterThanOrEqual(100);
      expect(await score('{ __type(name: "Query") { name } }')).toBeGreaterThanOrEqual(100);
    });
  });

  describe('countRootFields', () => {
    test('counts aliases and expands root fragments', () => {
      expect(rootFields('{ a: cheap b: cheap ...F } fragment F on Query { heavy { id } }')).toBe(3);
    });

    test('does not count meta fields', () => {
      expect(rootFields('{ __typename cheap }')).toBe(1);
    });
  });

  describe('arguments', () => {
    test('charges ROW_COST per requested row', async () => {
      expect(await score('{ cheap(limit: 50) }')).toBeCloseTo(1 + 5);
      // Plus de plafond à 100 lignes : 1 000 lignes coûtent 100
      expect(await score('{ cheap(limit: 1000) }')).toBeCloseTo(1 + 100);
    });

    test('bounds the rows at MAX_LIMIT, above which the resolver rejects the query', async () => {
      expect(await score('{ cheap(limit: 1000000) }')).toBeCloseTo(1 + 100);
    });

    test('charges the SDL default of an omitted limit', async () => {
      const options = { schema: LIMIT_SCHEMA };
      expect(await score('{ paged }', {}, options)).toBeCloseTo(5 + 10);
      expect(await score('{ options }', {}, options)).toBeCloseTo(5 + 5);
      // Champ sans argument limit : rien de plus
      expect(await score('{ plain }', {}, options)).toBe(5);
    });

    test('charges the explicit limit rather than the SDL default', async () => {
      expect(await score('{ paged(limit: 3) }', {}, { schema: LIMIT_SCHEMA })).toBeCloseTo(5 + 0.3);
    });

    test('charges filter and sort arguments', async () => {
      const filtered = await score('{ items(structuredFilters: {}, sort: []) { id } }');
      expect(filtered).toBe((await score('{ items { id } }')) + 3);
    });
  });

  describe('limit argument resolution', () => {
    const query = 'query Q($n: Int = 50) { items(limit: $n) { id } }';

    test('uses the value of a provided variable over its default', async () => {
      expect(await score(query, { n: 5 })).toBeCloseTo(await score('{ items(limit: 5) { id } }'));
      expect(await score(query, { n: 5 })).toBeLessThan(await score(query));
    });

    test('falls back to the default of the variable definition when omitted', async () => {
      // Régression AF2 : la variable omise faisait lire .kind sur undefined
      await expect(score(query)).resolves.toEqual(expect.any(Number));
      expect(await score(query)).toBeCloseTo(await score('{ items(limit: 50) { id } }'));
    });

    test('falls back to the default of the variable definition when undefined', async () => {
      expect(await score(query, { n: undefined })).toBeCloseTo(
        await score('{ items(limit: 50) { id } }'),
      );
    });

    test('charges the default page size for a null variable or literal', async () => {
      const defaultPage = await score('{ items(limit: 100) { id } }');
      expect(await score(query, { n: null })).toBeCloseTo(defaultPage);
      expect(await score('{ items(limit: null) { id } }')).toBeCloseTo(defaultPage);
    });

    test('never throws for an omitted variable without default', async () => {
      const withoutDefault = 'query Q($n: Int) { items(limit: $n) { id } }';
      expect(await score(withoutDefault)).toBeCloseTo(await score('{ items(limit: 100) { id } }'));
    });

    test('never throws for a variable of an unexpected type', async () => {
      const withoutDefault = 'query Q($n: Int) { items(limit: $n) { id } }';
      await expect(score(withoutDefault, { n: 'abc' })).resolves.toEqual(expect.any(Number));
      await expect(score(withoutDefault, { n: { deep: true } })).resolves.toEqual(
        expect.any(Number),
      );
    });

    test('applies to the first argument as to limit', async () => {
      const first = 'query Q($n: Int = 20) { items(first: $n) { id } }';
      expect(await score(first)).toBeCloseTo(await score('{ items(first: 20) { id } }'));
    });

    test('resolves defaults inside nested selections and fragments', async () => {
      const nested = `
        query Q($n: Int = 30) { cheap { ...F } }
        fragment F on T { items(limit: $n) { id } }
      `;
      expect(await score(nested)).toBeCloseTo(await score('{ cheap { items(limit: 30) { id } } }'));
    });
  });

  describe('Metadata.stats', () => {
    test('is priced per column of the schema for getCatalogSchema', async () => {
      const columns = counter(40);
      const cost = await score(
        '{ getCatalogSchema(catalog: "c", schema: "s") { name stats { min max } } }',
        {},
        { columns },
      );
      // Racine (2) + 5 par colonne, sans facteur de profondeur
      expect(cost).toBe(2 + 5 * 40);
      expect(columns.columnsOf).toHaveBeenCalledWith('c', 's');
    });

    test('reads catalog and schema from variables', async () => {
      const columns = counter(3);
      await score(
        'query Q($c: String) { getCatalogSchema(catalog: $c) { stats { min } } }',
        { c: 'macro' },
        { columns },
      );
      expect(columns.columnsOf).toHaveBeenCalledWith('macro', undefined);
    });

    test('does not count columns when stats is not selected', async () => {
      const columns = counter(40);
      expect(await score('{ getCatalogSchema { name label } }', {}, { columns })).toBe(2);
      expect(columns.columnsOf).not.toHaveBeenCalled();
    });

    test('follows fragments down to stats', async () => {
      const cost = await score(
        '{ getCatalogSchema { ...M } } fragment M on Metadata { stats { min } }',
        {},
        { columns: counter(40) },
      );
      expect(cost).toBe(2 + 200);
    });

    test('uses the fields argument of getFactTableWithMetadata when given', async () => {
      const columns = counter(40);
      const cost = await score(
        '{ getFactTableWithMetadata(fields: ["a", "b"]) { fields { stats { min } } } }',
        {},
        { columns },
      );
      // Racine (8) + objet `fields` (1 * 2^1) + 2 colonnes
      expect(cost).toBe(8 + 2 + 5 * 2);
      expect(columns.columnsOf).not.toHaveBeenCalled();
    });

    test('uses every column of the schema for getFactTableWithMetadata without fields', async () => {
      const cost = await score(
        '{ getFactTableWithMetadata { fields { stats { min } } } }',
        {},
        { columns: counter(40) },
      );
      expect(cost).toBe(8 + 2 + 5 * 40);
    });

    test('uses every column of every schema under getCatalogs', async () => {
      const columns = counter(10, 120);
      const cost = await score(
        '{ getCatalogs { id schemas { name fields { stats { min } } } } }',
        {},
        { columns },
      );
      // Racine (1) + schemas (2) + fields (4) + 120 colonnes
      expect(cost).toBe(1 + 2 + 4 + 5 * 120);
      expect(columns.allColumns).toHaveBeenCalledTimes(1);
    });

    test('prices a single Metadata as one column', async () => {
      const columns = counter(40);
      expect(await score('{ getMetaData(name: "x") { stats { min } } }', {}, { columns })).toBe(
        5 + 5,
      );
      expect(columns.columnsOf).not.toHaveBeenCalled();
    });

    test('counts one column per list without a column counter', async () => {
      expect(await score('{ getCatalogSchema { stats { min } } }')).toBe(2 + 5);
    });
  });

  describe('extractNumericValue', () => {
    test('extracts integer from IntValue node', () => {
      expect(analyzer.extractNumericValue({ kind: 'IntValue', value: '42' })).toBe(42);
    });

    test('extracts float from FloatValue node', () => {
      expect(analyzer.extractNumericValue({ kind: 'FloatValue', value: '3.14' })).toBeCloseTo(3.14);
    });

    test('returns plain number as-is', () => {
      expect(analyzer.extractNumericValue(5)).toBe(5);
    });

    test('returns 0 for unrecognised node kinds', () => {
      expect(analyzer.extractNumericValue({ kind: 'StringValue', value: 'text' })).toBe(0);
      expect(analyzer.extractNumericValue({})).toBe(0);
    });
  });
});
