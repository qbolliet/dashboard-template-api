/**
 * Unit tests for QueryComplexityAnalyzer (src/security/complexity-analyzer.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger to isolate the analyzer logic.
 * Covers calculate and extractNumericValue methods.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration mockée de la section SECURITY_LIMITS. */
interface MockConfig {
  SECURITY_LIMITS: { COMPLEXITY_CALCULATION_FACTOR: number };
}

/** Logger contextuel mocké — quatre méthodes de journalisation. */
interface MockLogger {
  security:  jest.Mock;
  operation: jest.Mock;
  warn:      jest.Mock;
  error:     jest.Mock;
}

/** Argument d'un nœud Field dans l'AST GraphQL — version minimale pour les tests. */
interface MockArgument {
  name:  { value: string };
  value: { kind: string; value: string };
}

/** Ensemble de sélections d'un nœud Field. */
interface MockSelectionSet {
  selections: MockFieldNode[];
}

/** Nœud Field minimal dans l'AST GraphQL. */
interface MockFieldNode {
  kind:         'Field';
  name:         { value: string };
  arguments:    MockArgument[];
  selectionSet: MockSelectionSet | null;
}

/** Sous-ensemble de GraphQLResolveInfo suffisant pour les tests de calculate. */
interface MockResolveInfo {
  fieldNodes:     MockFieldNode[];
  schema:         null;
  fragments:      Record<string, unknown>;
  variableValues: Record<string, unknown>;
}

/** Interface publique d'une instance de QueryComplexityAnalyzer. */
interface QueryComplexityAnalyzerInstance {
  calculate:           (info: unknown) => number;
  extractNumericValue: (node: unknown) => number;
}

/** Constructeur de QueryComplexityAnalyzer. */
interface QueryComplexityAnalyzerConstructor {
  new(config: Record<string, unknown>): QueryComplexityAnalyzerInstance;
}

// ─── Configuration mockée ─────────────────────────────────────────────────────

const mockConfig: MockConfig = {
  SECURITY_LIMITS: {
    COMPLEXITY_CALCULATION_FACTOR: 0.1
  }
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: (): MockLogger => ({
    security:  jest.fn(),
    operation: jest.fn(),
    warn:      jest.fn(),
    error:     jest.fn()
  })
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertion d'assignation définitive — assigné dans beforeAll avant tout test.
let QueryComplexityAnalyzer!: QueryComplexityAnalyzerConstructor;

beforeAll(async () => {
  ({ QueryComplexityAnalyzer } =
    await import('../../../src/security/complexity-analyzer.js') as {
      QueryComplexityAnalyzer: QueryComplexityAnalyzerConstructor;
    });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QueryComplexityAnalyzer', () => {
  let analyzer!: QueryComplexityAnalyzerInstance;

  beforeEach(() => {
    analyzer = new QueryComplexityAnalyzer({
      MAX_ALLOWED:        1000,
      SCALAR_COST:        0,
      OBJECT_COST:        1,
      LIST_FACTOR:        10,
      DEPTH_FACTOR:       2,
      INTROSPECTION_COST: 100,
      CUSTOM_SCORES:      {}
    });
  });

  describe('calculate', () => {
    test('returns 0 when info has no fieldNodes', () => {
      expect(analyzer.calculate({})).toBe(0);
      expect(analyzer.calculate(null)).toBe(0);
    });

    test('returns a non-negative score for a simple field', () => {
      // Construction d'un info minimal avec un seul champ scalaire
      const info: MockResolveInfo = {
        fieldNodes:     [{ kind: 'Field', name: { value: 'simpleField' }, arguments: [], selectionSet: null }],
        schema:         null,
        fragments:      {},
        variableValues: {}
      };
      expect(analyzer.calculate(info)).toBeGreaterThanOrEqual(0);
    });

    test('adds introspection cost for __schema', () => {
      // Requête d'introspection — surcoût de 100 points attendu
      const info: MockResolveInfo = {
        fieldNodes: [{
          kind: 'Field',
          name: { value: '__schema' },
          arguments: [],
          selectionSet: {
            selections: [{ kind: 'Field', name: { value: 'types' }, arguments: [], selectionSet: null }]
          }
        }],
        schema:         null,
        fragments:      {},
        variableValues: {}
      };
      expect(analyzer.calculate(info)).toBeGreaterThanOrEqual(100);
    });

    test('increases complexity for nested selections', () => {
      // Champ simple — référence de base pour la comparaison
      const simple: MockResolveInfo = {
        fieldNodes:     [{ kind: 'Field', name: { value: 'a' }, arguments: [], selectionSet: null }],
        schema:         null,
        fragments:      {},
        variableValues: {}
      };
      // Champ imbriqué sur trois niveaux — complexité attendue supérieure
      const nested: MockResolveInfo = {
        fieldNodes: [{
          kind: 'Field', name: { value: 'a' }, arguments: [],
          selectionSet: {
            selections: [{
              kind: 'Field', name: { value: 'b' }, arguments: [],
              selectionSet: {
                selections: [{ kind: 'Field', name: { value: 'c' }, arguments: [], selectionSet: null }]
              }
            }]
          }
        }],
        schema:         null,
        fragments:      {},
        variableValues: {}
      };
      expect(analyzer.calculate(nested)).toBeGreaterThan(analyzer.calculate(simple));
    });

    test('factors in limit arguments', () => {
      // Champ avec argument limit — facteur de liste appliqué au calcul
      const withLimit: MockResolveInfo = {
        fieldNodes: [{
          kind: 'Field', name: { value: 'items' },
          arguments: [{ name: { value: 'limit' }, value: { kind: 'IntValue', value: '50' } }],
          selectionSet: null
        }],
        schema:         null,
        fragments:      {},
        variableValues: {}
      };
      // Champ sans arguments — coût de base uniquement
      const withoutArgs: MockResolveInfo = {
        fieldNodes:     [{ kind: 'Field', name: { value: 'items' }, arguments: [], selectionSet: null }],
        schema:         null,
        fragments:      {},
        variableValues: {}
      };
      expect(analyzer.calculate(withLimit)).toBeGreaterThan(analyzer.calculate(withoutArgs));
    });

    test('uses custom score when field appears in customScores', () => {
      // Analyseur avec score personnalisé de 50 pour heavyField
      const customAnalyzer = new QueryComplexityAnalyzer({
        MAX_ALLOWED:        1000,
        OBJECT_COST:        1,
        DEPTH_FACTOR:       1,
        INTROSPECTION_COST: 100,
        CUSTOM_SCORES:      { heavyField: 50 }
      });
      const info: MockResolveInfo = {
        fieldNodes:     [{ kind: 'Field', name: { value: 'heavyField' }, arguments: [], selectionSet: null }],
        schema:         null,
        fragments:      {},
        variableValues: {}
      };
      expect(customAnalyzer.calculate(info)).toBeGreaterThanOrEqual(50);
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
