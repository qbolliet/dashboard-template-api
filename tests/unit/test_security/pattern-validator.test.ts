/**
 * Unit tests for PatternValidator (src/security/pattern-validator.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger to isolate the validator logic.
 * Covers validateQuery, compilePatterns, and reload methods.
 */

import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration mockée de la section patterns de sécurité. */
interface MockConfig {
  SECURITY_PATTERNS: { blocked: unknown[]; allowed: unknown[] };
  API: { SECURITY_THRESHOLDS: { QUERY_SNIPPET_LENGTH: number } };
}

/** Logger contextuel mocké — quatre méthodes de journalisation. */
interface MockLogger {
  security:  jest.Mock;
  operation: jest.Mock;
  warn:      jest.Mock;
  error:     jest.Mock;
}

/** Entrée de pattern bloqué compilé — regex + message + pattern original. */
interface BlockedPattern {
  regex:    RegExp;
  message:  string;
  original: string;
}

/** Patterns compilés du validateur — liste des patterns bloqués et autorisés. */
interface CompiledPatterns {
  blocked: BlockedPattern[];
  allowed: string[];
}

/** Interface publique d'une instance de PatternValidator. */
interface PatternValidatorInstance {
  compiledPatterns: CompiledPatterns;
  validateQuery:    (query: unknown) => Promise<void>;
  compilePatterns:  () => CompiledPatterns;
  reload:           () => void;
}

/** Constructeur de PatternValidator. */
interface PatternValidatorConstructor {
  new(): PatternValidatorInstance;
}

// ─── Configuration mockée ─────────────────────────────────────────────────────

const mockConfig: MockConfig = {
  SECURITY_PATTERNS: {
    blocked: [],
    allowed: []
  },
  API: {
    SECURITY_THRESHOLDS: {
      QUERY_SNIPPET_LENGTH: 100
    }
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
let PatternValidator!: PatternValidatorConstructor;

beforeAll(async () => {
  ({ PatternValidator } =
    await import('../../../src/security/pattern-validator.js') as {
      PatternValidator: PatternValidatorConstructor;
    });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternValidator', () => {
  let validator!: PatternValidatorInstance;

  beforeEach(() => {
    validator = new PatternValidator();
  });

  describe('validateQuery', () => {
    test('resolves without error for a normal query', async () => {
      await expect(validator.validateQuery('query { user { name } }')).resolves.toBeUndefined();
    });

    test('resolves without error for a complex query', async () => {
      const q = `query GetData($id: ID!) { record(id: $id) { id title items { value } } }`;
      await expect(validator.validateQuery(q)).resolves.toBeUndefined();
    });

    test('resolves without error for malformed input (not a validator responsibility)', async () => {
      // Validation lexicale — non responsabilité du PatternValidator
      await expect(validator.validateQuery('not valid graphql {{{')).resolves.toBeUndefined();
    });

    test('resolves without error for null / undefined input', async () => {
      await expect(validator.validateQuery(null)).resolves.toBeUndefined();
      await expect(validator.validateQuery(undefined)).resolves.toBeUndefined();
    });

    test('throws GraphQLError when query matches a blocked pattern', async () => {
      // Ajout manuel d'un pattern bloqué — simulation d'une règle de sécurité
      const blockedValidator = new PatternValidator();
      blockedValidator.compiledPatterns.blocked.push({
        regex:    /drop\s+table/i,
        message:  'DDL operations are forbidden',
        original: 'drop\\s+table'
      });
      await expect(blockedValidator.validateQuery('DROP TABLE users')).rejects.toThrow(GraphQLError);
    });

    test('thrown error has FORBIDDEN_PATTERN extension code', async () => {
      const blockedValidator = new PatternValidator();
      blockedValidator.compiledPatterns.blocked.push({
        regex:    /forbidden/i,
        message:  'Forbidden keyword',
        original: 'forbidden'
      });
      try {
        await blockedValidator.validateQuery('forbidden query');
      } catch (e) {
        expect((e as GraphQLError).extensions.code).toBe('FORBIDDEN_PATTERN');
      }
    });

    test('allows query that matches an allowed pattern, skipping blocked check', async () => {
      // Pattern dans la liste autorisée — doit contourner la vérification des bloqués
      const specificValidator = new PatternValidator();
      specificValidator.compiledPatterns.allowed.push('safe_operation');
      specificValidator.compiledPatterns.blocked.push({
        regex:    /safe_operation/i,
        message:  'Would be blocked without allow-list',
        original: 'safe_operation'
      });
      await expect(specificValidator.validateQuery('safe_operation')).resolves.toBeUndefined();
    });
  });

  describe('compilePatterns', () => {
    test('returns an object with blocked and allowed arrays', () => {
      const compiled = validator.compilePatterns();
      expect(Array.isArray(compiled.blocked)).toBe(true);
      expect(Array.isArray(compiled.allowed)).toBe(true);
    });

    test('does not throw on re-compilation', () => {
      expect(() => validator.compilePatterns()).not.toThrow();
    });
  });

  describe('reload', () => {
    test('does not throw', () => {
      expect(() => validator.reload()).not.toThrow();
    });

    test('resets compiled patterns to a new object reference', () => {
      // Référence initiale — doit changer après reload
      const before = validator.compiledPatterns;
      validator.reload();
      expect(validator.compiledPatterns).not.toBe(before);
    });
  });
});
