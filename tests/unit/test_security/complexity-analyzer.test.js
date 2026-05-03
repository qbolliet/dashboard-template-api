// Unit tests for src/security/complexity-analyzer.js
import { jest } from '@jest/globals';

// ─── Mock config ──────────────────────────────────────────────────────────────

const mockConfig = {
  SECURITY_LIMITS: {
    COMPLEXITY_CALCULATION_FACTOR: 0.1
  }
};

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    security: jest.fn(),
    operation: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let QueryComplexityAnalyzer;

beforeAll(async () => {
  ({ QueryComplexityAnalyzer } =
    await import('../../src/security/complexity-analyzer.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QueryComplexityAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new QueryComplexityAnalyzer({
      MAX_ALLOWED: 1000,
      SCALAR_COST: 0,
      OBJECT_COST: 1,
      LIST_FACTOR: 10,
      DEPTH_FACTOR: 2,
      INTROSPECTION_COST: 100,
      CUSTOM_SCORES: {}
    });
  });

  describe('calculate', () => {
    test('returns 0 when info has no fieldNodes', () => {
      expect(analyzer.calculate({})).toBe(0);
      expect(analyzer.calculate(null)).toBe(0);
    });

    test('returns a non-negative score for a simple field', () => {
      const info = {
        fieldNodes: [{ kind: 'Field', name: { value: 'simpleField' }, arguments: [], selectionSet: null }],
        schema: null, fragments: {}, variableValues: {}
      };
      expect(analyzer.calculate(info)).toBeGreaterThanOrEqual(0);
    });

    test('adds introspection cost for __schema', () => {
      const info = {
        fieldNodes: [{
          kind: 'Field',
          name: { value: '__schema' },
          arguments: [],
          selectionSet: {
            selections: [{ kind: 'Field', name: { value: 'types' }, arguments: [], selectionSet: null }]
          }
        }],
        schema: null, fragments: {}, variableValues: {}
      };
      expect(analyzer.calculate(info)).toBeGreaterThanOrEqual(100);
    });

    test('increases complexity for nested selections', () => {
      const simple = {
        fieldNodes: [{ kind: 'Field', name: { value: 'a' }, arguments: [], selectionSet: null }],
        schema: null, fragments: {}, variableValues: {}
      };
      const nested = {
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
        schema: null, fragments: {}, variableValues: {}
      };
      expect(analyzer.calculate(nested)).toBeGreaterThan(analyzer.calculate(simple));
    });

    test('factors in limit arguments', () => {
      const withLimit = {
        fieldNodes: [{
          kind: 'Field', name: { value: 'items' },
          arguments: [{ name: { value: 'limit' }, value: { kind: 'IntValue', value: '50' } }],
          selectionSet: null
        }],
        schema: null, fragments: {}, variableValues: {}
      };
      const withoutArgs = {
        fieldNodes: [{ kind: 'Field', name: { value: 'items' }, arguments: [], selectionSet: null }],
        schema: null, fragments: {}, variableValues: {}
      };
      expect(analyzer.calculate(withLimit)).toBeGreaterThan(analyzer.calculate(withoutArgs));
    });

    test('uses custom score when field appears in customScores', () => {
      const customAnalyzer = new QueryComplexityAnalyzer({
        MAX_ALLOWED: 1000,
        OBJECT_COST: 1,
        DEPTH_FACTOR: 1,
        INTROSPECTION_COST: 100,
        CUSTOM_SCORES: { heavyField: 50 }
      });
      const info = {
        fieldNodes: [{ kind: 'Field', name: { value: 'heavyField' }, arguments: [], selectionSet: null }],
        schema: null, fragments: {}, variableValues: {}
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
