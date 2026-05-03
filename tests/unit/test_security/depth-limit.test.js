// Unit tests for src/security/depth-limit.js
import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Mock config ──────────────────────────────────────────────────────────────

const mockConfig = {
  SECURITY: {
    SECURITY_LIMITS: {
      DEFAULT_DEPTH_LIMIT: 5
    }
  }
};

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let createDepthLimitRule, createSimpleDepthLimitRule;

beforeAll(async () => {
  ({ createDepthLimitRule, createSimpleDepthLimitRule } =
    await import('../../src/security/depth-limit.js'));
});

// ─── createDepthLimitRule ─────────────────────────────────────────────────────

describe('createDepthLimitRule', () => {
  describe('parameter validation', () => {
    test('throws when maxDepth is less than 1', () => {
      expect(() => createDepthLimitRule(0)).toThrow('maxDepth must be a positive integer');
    });

    test('throws when maxDepth is negative', () => {
      expect(() => createDepthLimitRule(-1)).toThrow();
    });

    test('throws when maxDepth is a float', () => {
      expect(() => createDepthLimitRule(1.5)).toThrow('maxDepth must be a positive integer');
    });

    test('accepts a valid positive integer', () => {
      expect(() => createDepthLimitRule(5)).not.toThrow();
    });
  });

  describe('rule factory', () => {
    test('returns a function (the validator factory)', () => {
      expect(typeof createDepthLimitRule(5)).toBe('function');
    });

    test('the factory returns a visitor object with a Document handler', () => {
      const rule = createDepthLimitRule(5);
      const mockContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      expect(typeof visitor.Document).toBe('function');
    });
  });

  describe('depth enforcement', () => {
    // Builds a query node with nesting of the given depth
    const makeOperation = (depth) => {
      let node = null;
      for (let i = depth; i >= 1; i--) {
        node = {
          kind: 'Field',
          name: { value: `level${i}` },
          selectionSet: node ? { selections: [node] } : null
        };
      }
      return {
        kind: 'OperationDefinition',
        selectionSet: { selections: [node] }
      };
    };

    test('does NOT report error when depth equals maxDepth', () => {
      const rule = createDepthLimitRule(3);
      const mockContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      visitor.Document({ definitions: [makeOperation(3)] });
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('reports error when depth exceeds maxDepth', () => {
      const rule = createDepthLimitRule(2);
      const mockContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      visitor.Document({ definitions: [makeOperation(3)] });
      expect(mockContext.reportError).toHaveBeenCalledWith(expect.any(GraphQLError));
    });

    test('does NOT report error for a flat query (depth 1)', () => {
      const rule = createDepthLimitRule(2);
      const mockContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      visitor.Document({ definitions: [makeOperation(1)] });
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('ignores non-OperationDefinition nodes', () => {
      const rule = createDepthLimitRule(1);
      const mockContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      const doc = {
        definitions: [{ kind: 'FragmentDefinition', selectionSet: { selections: [] } }]
      };
      visitor.Document(doc);
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('reports error with DEPTH_LIMIT_EXCEEDED extension code', () => {
      const rule = createDepthLimitRule(1);
      const mockContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      visitor.Document({ definitions: [makeOperation(2)] });
      const reportedError = mockContext.reportError.mock.calls[0][0];
      expect(reportedError.extensions.code).toBe('DEPTH_LIMIT_EXCEEDED');
    });
  });

  describe('InlineFragment handling', () => {
    test('traverses inline fragments without adding depth', () => {
      const rule = createDepthLimitRule(2);
      const mockContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      const doc = {
        definitions: [{
          kind: 'OperationDefinition',
          selectionSet: {
            selections: [{
              kind: 'InlineFragment',
              selectionSet: {
                selections: [{ kind: 'Field', name: { value: 'a' }, selectionSet: null }]
              }
            }]
          }
        }]
      };
      visitor.Document(doc);
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });
  });

  describe('FragmentSpread handling', () => {
    test('resolves and traverses a known fragment', () => {
      const rule = createDepthLimitRule(1);
      const fragment = {
        selectionSet: {
          selections: [
            { kind: 'Field', name: { value: 'deep' }, selectionSet: {
              selections: [{ kind: 'Field', name: { value: 'deeper' }, selectionSet: null }]
            }}
          ]
        }
      };
      const mockContext = {
        reportError: jest.fn(),
        getFragment: jest.fn().mockReturnValue(fragment)
      };
      const visitor = rule(mockContext);
      const doc = {
        definitions: [{
          kind: 'OperationDefinition',
          selectionSet: {
            selections: [{ kind: 'FragmentSpread', name: { value: 'MyFragment' } }]
          }
        }]
      };
      visitor.Document(doc);
      expect(mockContext.reportError).toHaveBeenCalled();
    });

    test('skips unknown fragment spread without throwing', () => {
      const rule = createDepthLimitRule(5);
      const mockContext = {
        reportError: jest.fn(),
        getFragment: jest.fn().mockReturnValue(null)
      };
      const visitor = rule(mockContext);
      const doc = {
        definitions: [{
          kind: 'OperationDefinition',
          selectionSet: {
            selections: [{ kind: 'FragmentSpread', name: { value: 'UnknownFragment' } }]
          }
        }]
      };
      expect(() => visitor.Document(doc)).not.toThrow();
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });
  });
});

// ─── createSimpleDepthLimitRule ───────────────────────────────────────────────

describe('createSimpleDepthLimitRule', () => {
  describe('parameter validation', () => {
    test('throws when maxDepth is less than 1', () => {
      expect(() => createSimpleDepthLimitRule(0)).toThrow('maxDepth must be a positive integer');
    });

    test('throws when maxDepth is a float', () => {
      expect(() => createSimpleDepthLimitRule(2.5)).toThrow('maxDepth must be a positive integer');
    });

    test('accepts a valid positive integer', () => {
      expect(() => createSimpleDepthLimitRule(3)).not.toThrow();
    });
  });

  describe('rule factory', () => {
    test('returns a function', () => {
      expect(typeof createSimpleDepthLimitRule(3)).toBe('function');
    });

    test('the factory returns a visitor with Field enter/leave', () => {
      const rule = createSimpleDepthLimitRule(3);
      const mockContext = { reportError: jest.fn() };
      const visitor = rule(mockContext);
      expect(typeof visitor.Field.enter).toBe('function');
      expect(typeof visitor.Field.leave).toBe('function');
    });
  });

  describe('depth enforcement via stack', () => {
    test('does not report error when nesting stays within maxDepth', () => {
      const rule = createSimpleDepthLimitRule(3);
      const mockContext = { reportError: jest.fn() };
      const visitor = rule(mockContext);
      const node = { name: { value: 'x' } };

      visitor.Field.enter(node); // depth 1
      visitor.Field.enter(node); // depth 2
      visitor.Field.enter(node); // depth 3
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('reports error when nesting exceeds maxDepth', () => {
      const rule = createSimpleDepthLimitRule(2);
      const mockContext = { reportError: jest.fn() };
      const visitor = rule(mockContext);
      const node = { name: { value: 'x' } };

      visitor.Field.enter(node); // depth 1
      visitor.Field.enter(node); // depth 2
      visitor.Field.enter(node); // depth 3 → exceeds 2
      expect(mockContext.reportError).toHaveBeenCalledWith(expect.any(GraphQLError));
    });

    test('leave pops from the stack', () => {
      const rule = createSimpleDepthLimitRule(2);
      const mockContext = { reportError: jest.fn() };
      const visitor = rule(mockContext);
      const node = { name: { value: 'x' } };

      visitor.Field.enter(node); // depth 1
      visitor.Field.enter(node); // depth 2
      visitor.Field.leave();     // back to 1
      visitor.Field.enter(node); // depth 2 again — still within limit
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('reports error with DEPTH_LIMIT_EXCEEDED extension code and maxDepth', () => {
      const rule = createSimpleDepthLimitRule(1);
      const mockContext = { reportError: jest.fn() };
      const visitor = rule(mockContext);
      const node = { name: { value: 'x' } };

      visitor.Field.enter(node); // depth 1
      visitor.Field.enter(node); // depth 2 → exceeds 1
      const err = mockContext.reportError.mock.calls[0][0];
      expect(err.extensions.code).toBe('DEPTH_LIMIT_EXCEEDED');
      expect(err.extensions.maxDepth).toBe(1);
    });
  });
});
