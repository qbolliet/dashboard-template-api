/**
 * Unit tests for createDepthLimitRule and createSimpleDepthLimitRule
 * (src/security/depth-limit.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader to contrôler la limite de profondeur par défaut.
 * Covers parameter validation, rule factory behaviour, depth enforcement,
 * InlineFragment traversal, and FragmentSpread resolution.
 */

import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration mockée de la section sécurité. */
interface MockConfig {
  SECURITY: {
    SECURITY_LIMITS: { DEFAULT_DEPTH_LIMIT: number };
  };
}

/** Contexte de validation GraphQL mocké — reportError + getFragment. */
interface MockValidationContext {
  reportError: jest.Mock;
  getFragment: jest.Mock;
}

/** Nœud Field minimal dans l'AST GraphQL. */
interface MockFieldNode {
  kind:         'Field';
  name:         { value: string };
  selectionSet: MockSelectionSet | null;
}

/** Nœud InlineFragment minimal dans l'AST GraphQL. */
interface MockInlineFragmentNode {
  kind:         'InlineFragment';
  selectionSet: MockSelectionSet;
}

/** Nœud FragmentSpread minimal dans l'AST GraphQL. */
interface MockFragmentSpreadNode {
  kind: 'FragmentSpread';
  name: { value: string };
}

/** Ensemble de sélections d'un nœud Field, InlineFragment ou FragmentDefinition. */
interface MockSelectionSet {
  selections: Array<MockFieldNode | MockInlineFragmentNode | MockFragmentSpreadNode>;
}

/** Définition d'opération GraphQL utilisée pour les tests de profondeur. */
interface MockOperationDefinition {
  kind:         'OperationDefinition';
  selectionSet: MockSelectionSet;
}

/** Document GraphQL contenant des définitions d'opérations et de fragments. */
interface MockDocument {
  definitions: Array<
    MockOperationDefinition |
    { kind: string; selectionSet: MockSelectionSet }
  >;
}

/** Visiteur retourné par la règle de profondeur avancée (parcours AST complet). */
interface DepthLimitVisitor {
  Document: (doc: MockDocument) => void;
}

/** Visiteur retourné par la règle de profondeur simple (compteur de pile). */
interface SimpleDepthLimitVisitor {
  Field: {
    enter: (node: { name: { value: string } }) => void;
    leave: () => void;
  };
}

/** Fabrique de règle de profondeur avancée. */
type DepthLimitRuleFactory = (maxDepth: number) => (context: MockValidationContext) => DepthLimitVisitor;

/** Fabrique de règle de profondeur simple. */
type SimpleDepthLimitRuleFactory = (maxDepth: number) => (context: MockValidationContext) => SimpleDepthLimitVisitor;

// ─── Configuration mockée ─────────────────────────────────────────────────────

const mockConfig: MockConfig = {
  SECURITY: {
    SECURITY_LIMITS: {
      DEFAULT_DEPTH_LIMIT: 5
    }
  }
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertions d'assignation définitive — assignés dans beforeAll avant tout test.
let createDepthLimitRule!: DepthLimitRuleFactory;
let createSimpleDepthLimitRule!: SimpleDepthLimitRuleFactory;

beforeAll(async () => {
  ({ createDepthLimitRule, createSimpleDepthLimitRule } =
    await import('../../../src/security/depth-limit.js') as {
      createDepthLimitRule:       DepthLimitRuleFactory;
      createSimpleDepthLimitRule: SimpleDepthLimitRuleFactory;
    });
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
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      expect(typeof visitor.Document).toBe('function');
    });
  });

  describe('depth enforcement', () => {
    /**
     * Builds a synthetic operation AST node with the given nesting depth.
     *
     * Args:
     *     depth: Number of nested Field levels to create.
     *
     * Returns:
     *     MockOperationDefinition with Field nodes nested to the requested depth.
     */
    const makeOperation = (depth: number): MockOperationDefinition => {
      // Construction récursive de bas en haut — du nœud le plus profond vers la racine
      let node: MockFieldNode | null = null;
      for (let i = depth; i >= 1; i--) {
        node = {
          kind:         'Field',
          name:         { value: `level${i}` },
          selectionSet: node ? { selections: [node] } : null
        };
      }
      return {
        kind:         'OperationDefinition',
        selectionSet: { selections: node ? [node] : [] }
      };
    };

    test('does NOT report error when depth equals maxDepth', () => {
      const rule = createDepthLimitRule(3);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      visitor.Document({ definitions: [makeOperation(3)] });
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('reports error when depth exceeds maxDepth', () => {
      const rule = createDepthLimitRule(2);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      visitor.Document({ definitions: [makeOperation(3)] });
      expect(mockContext.reportError).toHaveBeenCalledWith(expect.any(GraphQLError));
    });

    test('does NOT report error for a flat query (depth 1)', () => {
      const rule = createDepthLimitRule(2);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      visitor.Document({ definitions: [makeOperation(1)] });
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('ignores non-OperationDefinition nodes', () => {
      const rule = createDepthLimitRule(1);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      const doc: MockDocument = {
        definitions: [{ kind: 'FragmentDefinition', selectionSet: { selections: [] } }]
      };
      visitor.Document(doc);
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('reports error with DEPTH_LIMIT_EXCEEDED extension code', () => {
      const rule = createDepthLimitRule(1);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      visitor.Document({ definitions: [makeOperation(2)] });
      // Extraction de l'erreur rapportée pour vérification du code d'extension
      const reportedError = mockContext.reportError.mock.calls[0][0] as GraphQLError;
      expect(reportedError.extensions.code).toBe('DEPTH_LIMIT_EXCEEDED');
    });
  });

  describe('InlineFragment handling', () => {
    test('traverses inline fragments without adding depth', () => {
      // Fragment inline — ne doit pas incrémenter la profondeur
      const rule = createDepthLimitRule(2);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      const doc: MockDocument = {
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
      // Fragment mocké — deux niveaux de profondeur, attendu de déclencher l'erreur
      const fragment = {
        selectionSet: {
          selections: [
            {
              kind: 'Field', name: { value: 'deep' }, selectionSet: {
                selections: [{ kind: 'Field', name: { value: 'deeper' }, selectionSet: null }]
              }
            }
          ]
        }
      };
      const mockContext: MockValidationContext = {
        reportError: jest.fn(),
        getFragment:  jest.fn().mockReturnValue(fragment)
      };
      const visitor = rule(mockContext);
      const doc: MockDocument = {
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
      // Fragment inconnu — getFragment retourne null, aucune erreur attendue
      const rule = createDepthLimitRule(5);
      const mockContext: MockValidationContext = {
        reportError: jest.fn(),
        getFragment:  jest.fn().mockReturnValue(null)
      };
      const visitor = rule(mockContext);
      const doc: MockDocument = {
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
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      expect(typeof visitor.Field.enter).toBe('function');
      expect(typeof visitor.Field.leave).toBe('function');
    });
  });

  describe('depth enforcement via stack', () => {
    test('does not report error when nesting stays within maxDepth', () => {
      const rule = createSimpleDepthLimitRule(3);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      const node = { name: { value: 'x' } };

      visitor.Field.enter(node); // profondeur 1
      visitor.Field.enter(node); // profondeur 2
      visitor.Field.enter(node); // profondeur 3
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('reports error when nesting exceeds maxDepth', () => {
      const rule = createSimpleDepthLimitRule(2);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      const node = { name: { value: 'x' } };

      visitor.Field.enter(node); // profondeur 1
      visitor.Field.enter(node); // profondeur 2
      visitor.Field.enter(node); // profondeur 3 → dépassement de 2
      expect(mockContext.reportError).toHaveBeenCalledWith(expect.any(GraphQLError));
    });

    test('leave pops from the stack', () => {
      // Dépilage via leave — la profondeur doit revenir à 1 après leave
      const rule = createSimpleDepthLimitRule(2);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      const node = { name: { value: 'x' } };

      visitor.Field.enter(node); // profondeur 1
      visitor.Field.enter(node); // profondeur 2
      visitor.Field.leave();     // retour à 1
      visitor.Field.enter(node); // profondeur 2 à nouveau — dans la limite
      expect(mockContext.reportError).not.toHaveBeenCalled();
    });

    test('reports error with DEPTH_LIMIT_EXCEEDED extension code and maxDepth', () => {
      const rule = createSimpleDepthLimitRule(1);
      const mockContext: MockValidationContext = { reportError: jest.fn(), getFragment: jest.fn() };
      const visitor = rule(mockContext);
      const node = { name: { value: 'x' } };

      visitor.Field.enter(node); // profondeur 1
      visitor.Field.enter(node); // profondeur 2 → dépassement de 1
      // Extraction de l'erreur rapportée pour vérification des extensions
      const err = mockContext.reportError.mock.calls[0][0] as GraphQLError;
      expect(err.extensions.code).toBe('DEPTH_LIMIT_EXCEEDED');
      expect(err.extensions.maxDepth).toBe(1);
    });
  });
});
