// Unit tests for src/security/pattern-validator.js
import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Mock config ──────────────────────────────────────────────────────────────

const mockConfig = {
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

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    security: jest.fn(),
    operation: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let PatternValidator;

beforeAll(async () => {
  ({ PatternValidator } = await import('../../../src/security/pattern-validator.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternValidator', () => {
  let validator;

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
      await expect(validator.validateQuery('not valid graphql {{{')).resolves.toBeUndefined();
    });

    test('resolves without error for null / undefined input', async () => {
      await expect(validator.validateQuery(null)).resolves.toBeUndefined();
      await expect(validator.validateQuery(undefined)).resolves.toBeUndefined();
    });

    test('throws GraphQLError when query matches a blocked pattern', async () => {
      const blockedValidator = new PatternValidator();
      blockedValidator.compiledPatterns.blocked.push({
        regex: /drop\s+table/i,
        message: 'DDL operations are forbidden',
        original: 'drop\\s+table'
      });
      await expect(blockedValidator.validateQuery('DROP TABLE users')).rejects.toThrow(GraphQLError);
    });

    test('thrown error has FORBIDDEN_PATTERN extension code', async () => {
      const blockedValidator = new PatternValidator();
      blockedValidator.compiledPatterns.blocked.push({
        regex: /forbidden/i,
        message: 'Forbidden keyword',
        original: 'forbidden'
      });
      try {
        await blockedValidator.validateQuery('forbidden query');
      } catch (e) {
        expect(e.extensions.code).toBe('FORBIDDEN_PATTERN');
      }
    });

    test('allows query that matches an allowed pattern, skipping blocked check', async () => {
      const specificValidator = new PatternValidator();
      specificValidator.compiledPatterns.allowed.push('safe_operation');
      specificValidator.compiledPatterns.blocked.push({
        regex: /safe_operation/i,
        message: 'Would be blocked without allow-list',
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
      const before = validator.compiledPatterns;
      validator.reload();
      expect(validator.compiledPatterns).not.toBe(before);
    });
  });
});
