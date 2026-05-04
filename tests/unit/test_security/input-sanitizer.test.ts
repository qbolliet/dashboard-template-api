/**
 * Unit tests for InputSanitizer (src/security/input-sanitizer.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger to isolate the sanitizer logic.
 * Covers sanitizeAll, sanitizeXSS, sanitizeSQL, sanitizeNumber,
 * and sanitizeValue methods.
 */

import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Logger contextuel mocké — quatre méthodes de journalisation. */
interface MockLogger {
  security:  jest.Mock;
  operation: jest.Mock;
  warn:      jest.Mock;
  error:     jest.Mock;
}

/** Configuration initiale passée au constructeur d'InputSanitizer. */
interface InputSanitizerConfig {
  ENABLE_XSS:        boolean;
  ENABLE_SQL:        boolean;
  MAX_STRING_LENGTH: number;
  ALLOWED_TAGS:      string[];
  CUSTOM_SANITIZERS: Record<string, (v: string) => string>;
}

/** Interface publique d'une instance d'InputSanitizer. */
interface InputSanitizerInstance {
  sanitizeAll:    (input: unknown, key?: string) => unknown;
  sanitizeXSS:    (input: string) => string;
  sanitizeSQL:    (input: string) => string;
  sanitizeNumber: (input: number, field: string) => number;
  sanitizeValue:  (input: string, field: string) => string;
}

/** Constructeur d'InputSanitizer. */
interface InputSanitizerConstructor {
  new(config: InputSanitizerConfig): InputSanitizerInstance;
}

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: {}
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
let InputSanitizer!: InputSanitizerConstructor;

beforeAll(async () => {
  ({ InputSanitizer } =
    await import('../../../src/security/input-sanitizer.js') as {
      InputSanitizer: InputSanitizerConstructor;
    });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InputSanitizer', () => {
  let sanitizer!: InputSanitizerInstance;

  beforeEach(() => {
    sanitizer = new InputSanitizer({
      ENABLE_XSS:        true,
      ENABLE_SQL:        true,
      MAX_STRING_LENGTH: 100,
      ALLOWED_TAGS:      [],
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
      const result = sanitizer.sanitizeAll(input) as typeof input;
      expect(result.field1).not.toContain('<script>');
      expect(result.nested.field2).toBe('safe');
    });

    test('sanitizes elements inside arrays', () => {
      const input = { items: ['<script>alert(1)</script>', 'normal'] };
      const result = sanitizer.sanitizeAll(input) as typeof input;
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items[0]).not.toContain('<script>');
      expect(result.items[1]).toBe('normal');
    });

    test('passes primitives through unchanged', () => {
      expect(sanitizer.sanitizeAll(42)).toBe(42);
      expect(sanitizer.sanitizeAll(true)).toBe(true);
    });

    test('applies custom sanitizer when key matches', () => {
      // Sanitizer personnalisé — transformation en majuscules pour la clé "special"
      const custom = new InputSanitizer({
        ENABLE_XSS:        false,
        ENABLE_SQL:        false,
        MAX_STRING_LENGTH: 1000,
        ALLOWED_TAGS:      [],
        CUSTOM_SANITIZERS: { special: (v: string) => v.toUpperCase() }
      });
      expect((custom.sanitizeAll({ special: 'hello' }) as Record<string, string>).special).toBe('HELLO');
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
        expect((e as GraphQLError).extensions.code).toBe('SQL_INJECTION_PREVENTED');
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
      // Chaîne de 101 caractères — dépasse la limite de 100
      expect(() => sanitizer.sanitizeValue('a'.repeat(101), 'longField')).toThrow(GraphQLError);
    });

    test('accepts strings at exactly maxStringLength', () => {
      // Chaîne de 100 caractères — exactement à la limite, aucune erreur attendue
      expect(() => sanitizer.sanitizeValue('a'.repeat(100), 'field')).not.toThrow();
    });
  });
});
