/**
 * Unit tests for QueryComplexityAnalyzer (src/security/complexity-analyzer.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger to isolate the analyzer logic.
 * Covers calculateForOperation (document-level scoring, leaf vs object cost,
 * fragments, arguments) and extractNumericValue.
 */

import { jest } from '@jest/globals';
import { parse } from 'graphql';
import type { DocumentNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration mockée de la section SECURITY_LIMITS. */
interface MockConfig {
  SECURITY_LIMITS: { COMPLEXITY_CALCULATION_FACTOR: number };
}

/** Logger contextuel mocké — quatre méthodes de journalisation. */
interface MockLogger {
  security: jest.Mock;
  operation: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

/** Interface publique d'une instance de QueryComplexityAnalyzer. */
interface QueryComplexityAnalyzerInstance {
  calculateForOperation: (
    operation: OperationDefinitionNode,
    fragments?: Record<string, FragmentDefinitionNode>,
    variables?: Record<string, unknown>,
  ) => number;
  maxAllowed: number;
  extractNumericValue: (node: unknown) => number;
}

/** Constructeur de QueryComplexityAnalyzer. */
interface QueryComplexityAnalyzerConstructor {
  new (config: Record<string, unknown>): QueryComplexityAnalyzerInstance;
}

// ─── Configuration mockée ─────────────────────────────────────────────────────

const mockConfig: MockConfig = {
  SECURITY_LIMITS: {
    COMPLEXITY_CALCULATION_FACTOR: 0.1,
  },
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

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
   * @returns The complexity score of the first operation.
   */
  const score = (source: string, variables: Record<string, unknown> = {}): number => {
    const { operation, fragments } = parseOperation(source);
    return analyzer.calculateForOperation(operation, fragments, variables);
  };

  beforeEach(() => {
    analyzer = new QueryComplexityAnalyzer({
      MAX_ALLOWED: 1000,
      SCALAR_COST: 0,
      OBJECT_COST: 1,
      LIST_FACTOR: 10,
      DEPTH_FACTOR: 2,
      INTROSPECTION_COST: 100,
      CUSTOM_SCORES: {},
    });
  });

  describe('calculateForOperation', () => {
    test('exposes the configured ceiling', () => {
      expect(analyzer.maxAllowed).toBe(1000);
    });

    test('returns 0 for an operation made of scalar leaves only', () => {
      // SCALAR_COST vaut 0 — les feuilles ne coûtent rien par elles-mêmes
      expect(score('{ a b c }')).toBe(0);
    });

    test('charges OBJECT_COST for fields carrying a selection set', () => {
      // Racine (1 * 2^0) + enfant objet (1 * 2^1), les feuilles étant gratuites
      expect(score('{ a { b { c } } }')).toBe(3);
    });

    test('sums every root field of the operation', () => {
      const single = score('{ a { x } }');
      const double = score('{ a { x } b { x } }');
      expect(double).toBe(single * 2);
    });

    test('adds introspection cost for __schema', () => {
      expect(score('{ __schema { types { name } } }')).toBeGreaterThanOrEqual(100);
    });

    test('increases complexity for nested selections', () => {
      expect(score('{ a { b { c { d } } } }')).toBeGreaterThan(score('{ a { b } }'));
    });

    test('factors in limit arguments', () => {
      expect(score('{ items(limit: 50) { id } }')).toBeGreaterThan(score('{ items { id } }'));
    });

    test('resolves limit arguments passed through variables', () => {
      const withVariable = score('query Q($n: Int) { items(limit: $n) { id } }', { n: 50 });
      expect(withVariable).toBeGreaterThan(score('{ items { id } }'));
    });

    test('charges filter and sort arguments', () => {
      const filtered = score('{ items(structuredFilters: {}, sort: []) { id } }');
      expect(filtered).toBe(score('{ items { id } }') + 3);
    });

    test('uses custom score when field appears in customScores', () => {
      // Analyseur avec score personnalisé de 50 pour heavyField
      const customAnalyzer = new QueryComplexityAnalyzer({
        MAX_ALLOWED: 1000,
        SCALAR_COST: 0,
        OBJECT_COST: 1,
        DEPTH_FACTOR: 1,
        INTROSPECTION_COST: 100,
        CUSTOM_SCORES: { heavyField: 50 },
      });
      const { operation, fragments } = parseOperation('{ heavyField { id } }');
      expect(customAnalyzer.calculateForOperation(operation, fragments)).toBeGreaterThanOrEqual(50);
    });

    test('applies custom scores at any depth', () => {
      // Un score personnalisé sur un champ imbriqué doit peser lui aussi
      const customAnalyzer = new QueryComplexityAnalyzer({
        MAX_ALLOWED: 1000,
        SCALAR_COST: 0,
        OBJECT_COST: 1,
        DEPTH_FACTOR: 1,
        INTROSPECTION_COST: 100,
        CUSTOM_SCORES: { stats: 40 },
      });
      const { operation, fragments } = parseOperation('{ metadata { stats { min } } }');
      expect(customAnalyzer.calculateForOperation(operation, fragments)).toBeGreaterThanOrEqual(40);
    });

    test('expands named fragments without depth inflation', () => {
      const withFragment = score(`
        { a { ...Inner } }
        fragment Inner on Thing { b { c } }
      `);
      expect(withFragment).toBe(score('{ a { b { c } } }'));
    });

    test('ignores unknown fragment spreads instead of throwing', () => {
      const { operation } = parseOperation('{ a { ...Missing } }');
      expect(analyzer.calculateForOperation(operation, {})).toBe(1);
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
