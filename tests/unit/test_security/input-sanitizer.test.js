// Unit tests for src/security/input-sanitizer.js
import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: {}
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

let InputSanitizer;

beforeAll(async () => {
  ({ InputSanitizer } = await import('../../../src/security/input-sanitizer.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InputSanitizer', () => {
  let sanitizer;

  beforeEach(() => {
    sanitizer = new InputSanitizer({
      ENABLE_XSS: true,
      ENABLE_SQL: true,
      MAX_STRING_LENGTH: 100,
      ALLOWED_TAGS: [],
      CUSTOM_SANITIZERS: {}
    });
  });

  describe('sanitizeAll', () => {
    test('returns null/undefined unchanged', () => {
      expect(sanitizer.sanitizeAll(null)).toBeNull();
      expect(sanitizer.sanitizeAll(undefined)).toBeUndefined();
    });

    test('sanitizes string values inside an object recursively', () => {
      const input = { field1: '<script>xss()</script>Hello', nested: { field2: 'safe' } };
      const result = sanitizer.sanitizeAll(input);
      expect(result.field1).not.toContain('<script>');
      expect(result.nested.field2).toBe('safe');
    });

    test('sanitizes elements inside arrays', () => {
      const input = { items: ['<script>alert(1)</script>', 'normal'] };
      const result = sanitizer.sanitizeAll(input);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items[0]).not.toContain('<script>');
      expect(result.items[1]).toBe('normal');
    });

    test('passes primitives through unchanged', () => {
      expect(sanitizer.sanitizeAll(42)).toBe(42);
      expect(sanitizer.sanitizeAll(true)).toBe(true);
    });

    test('applies custom sanitizer when key matches', () => {
      const custom = new InputSanitizer({
        ENABLE_XSS: false, ENABLE_SQL: false,
        MAX_STRING_LENGTH: 1000, ALLOWED_TAGS: [],
        CUSTOM_SANITIZERS: { special: v => v.toUpperCase() }
      });
      expect(custom.sanitizeAll({ special: 'hello' }).special).toBe('HELLO');
    });
  });

  describe('sanitizeXSS', () => {
    test('removes script tags', () => {
      const result = sanitizer.sanitizeXSS('<script>alert("xss")</script>Hello');
      expect(result).not.toContain('<script>');
      expect(result).toContain('Hello');
    });

    test('strips javascript: URIs', () => {
      expect(sanitizer.sanitizeXSS('<a href="javascript:alert(1)">click</a>')).not.toContain('javascript:');
    });

    test('strips on* event handlers', () => {
      expect(sanitizer.sanitizeXSS('<img src="x" onerror="alert(1)">')).not.toContain('onerror');
    });

    test('leaves clean strings unchanged', () => {
      expect(sanitizer.sanitizeXSS('Hello World')).toBe('Hello World');
    });
  });

  describe('sanitizeSQL', () => {
    test('passes safe strings through unchanged', () => {
      expect(sanitizer.sanitizeSQL('normal string value')).toBe('normal string value');
    });

    test('throws GraphQLError on SQL line comment sequences (--)', () => {
      expect(() => sanitizer.sanitizeSQL("'; DROP TABLE users; --")).toThrow(GraphQLError);
    });

    test('thrown error has SQL_INJECTION_PREVENTED extension code', () => {
      try {
        sanitizer.sanitizeSQL("value'; --");
      } catch (e) {
        expect(e.extensions.code).toBe('SQL_INJECTION_PREVENTED');
      }
    });

    test('throws GraphQLError on block comment sequences (/*)', () => {
      expect(() => sanitizer.sanitizeSQL('SELECT /* comment */ 1')).toThrow(GraphQLError);
    });
  });

  describe('sanitizeNumber', () => {
    test('accepts valid integers', () => {
      expect(sanitizer.sanitizeNumber(42, 'field')).toBe(42);
    });

    test('accepts valid floats', () => {
      expect(sanitizer.sanitizeNumber(3.14, 'field')).toBe(3.14);
    });

    test('accepts negative numbers', () => {
      expect(sanitizer.sanitizeNumber(-7, 'field')).toBe(-7);
    });

    test('throws for NaN', () => {
      expect(() => sanitizer.sanitizeNumber(NaN, 'field')).toThrow(GraphQLError);
    });

    test('throws for Infinity', () => {
      expect(() => sanitizer.sanitizeNumber(Infinity, 'field')).toThrow(GraphQLError);
      expect(() => sanitizer.sanitizeNumber(-Infinity, 'field')).toThrow(GraphQLError);
    });

    test('throws when value exceeds MAX_SAFE_INTEGER', () => {
      expect(() => sanitizer.sanitizeNumber(Number.MAX_SAFE_INTEGER + 1, 'field')).toThrow(GraphQLError);
    });
  });

  describe('sanitizeValue — string length guard', () => {
    test('throws when string exceeds maxStringLength', () => {
      expect(() => sanitizer.sanitizeValue('a'.repeat(101), 'longField')).toThrow(GraphQLError);
    });

    test('accepts strings at exactly maxStringLength', () => {
      expect(() => sanitizer.sanitizeValue('a'.repeat(100), 'field')).not.toThrow();
    });
  });
});
