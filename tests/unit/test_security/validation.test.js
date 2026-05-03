// Unit tests for src/security/validation.js
import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Mock config ──────────────────────────────────────────────────────────────

const mockConfig = {
  API: {
    SECURITY_THRESHOLDS: {
      VALIDATION_MAX_LENGTH: 10000
    }
  }
};

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let validateInput, ValidationRules;

beforeAll(async () => {
  ({ validateInput, ValidationRules } =
    await import('../../src/security/validation.js'));
});

// ─── ValidationRules ─────────────────────────────────────────────────────────

describe('ValidationRules', () => {
  test('STRING rule has correct structure', () => {
    expect(ValidationRules.STRING.type).toBe('string');
    expect(ValidationRules.STRING.minLength).toBe(0);
    expect(typeof ValidationRules.STRING.maxLength).toBe('number');
  });

  test('NUMBER rule has correct structure', () => {
    expect(ValidationRules.NUMBER.type).toBe('number');
    expect(ValidationRules.NUMBER.min).toBe(Number.MIN_SAFE_INTEGER);
    expect(ValidationRules.NUMBER.max).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('STRING.maxLength comes from config mock (10000)', () => {
    expect(ValidationRules.STRING.maxLength).toBe(10000);
  });
});

// ─── validateInput ────────────────────────────────────────────────────────────

describe('validateInput', () => {
  describe('null / undefined handling', () => {
    test('returns null when input is null and field not required', () => {
      expect(validateInput(null)).toBeNull();
    });

    test('returns undefined when input is undefined and field not required', () => {
      expect(validateInput(undefined)).toBeUndefined();
    });

    test('throws REQUIRED_FIELD when input is null and required: true', () => {
      expect(() =>
        validateInput(null, { ...ValidationRules.STRING, required: true })
      ).toThrow(GraphQLError);
    });

    test('REQUIRED_FIELD error has correct extension code', () => {
      try {
        validateInput(null, { ...ValidationRules.STRING, required: true });
      } catch (e) {
        expect(e.extensions.code).toBe('REQUIRED_FIELD');
      }
    });
  });

  describe('type mismatch', () => {
    test('throws TYPE_MISMATCH when string is given for NUMBER rule', () => {
      expect(() => validateInput('hello', ValidationRules.NUMBER)).toThrow(GraphQLError);
    });

    test('throws TYPE_MISMATCH when number is given for STRING rule', () => {
      expect(() => validateInput(42, ValidationRules.STRING)).toThrow(GraphQLError);
    });

    test('throws TYPE_MISMATCH when array is given for STRING rule', () => {
      expect(() => validateInput(['a', 'b'], ValidationRules.STRING)).toThrow(GraphQLError);
    });

    test('TYPE_MISMATCH error contains expected and actual types', () => {
      try {
        validateInput(42, ValidationRules.STRING);
      } catch (e) {
        expect(e.message).toContain('string');
        expect(e.message).toContain('number');
      }
    });
  });

  describe('string validation', () => {
    test('returns valid string unchanged', () => {
      expect(validateInput('hello world')).toBe('hello world');
    });

    test('returns empty string unchanged', () => {
      expect(validateInput('')).toBe('');
    });

    test('throws STRING_TOO_LONG when string exceeds maxLength', () => {
      const longString = 'a'.repeat(10001);
      try {
        validateInput(longString, ValidationRules.STRING);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        expect(e.extensions.code).toBe('STRING_TOO_LONG');
      }
    });

    test('throws STRING_TOO_SHORT when string is shorter than minLength', () => {
      const strictRule = { type: 'string', minLength: 3, maxLength: 100 };
      expect(() => validateInput('ab', strictRule)).toThrow(GraphQLError);
    });

    test('STRING_TOO_SHORT error has correct extension code', () => {
      const strictRule = { type: 'string', minLength: 5, maxLength: 100 };
      try {
        validateInput('hi', strictRule);
      } catch (e) {
        expect(e.extensions.code).toBe('STRING_TOO_SHORT');
      }
    });

    test('accepts string exactly at maxLength', () => {
      const rule = { type: 'string', minLength: 0, maxLength: 5 };
      expect(validateInput('hello', rule)).toBe('hello');
    });
  });

  describe('number validation', () => {
    test('returns valid integer unchanged', () => {
      expect(validateInput(42, ValidationRules.NUMBER)).toBe(42);
    });

    test('returns valid negative number unchanged', () => {
      expect(validateInput(-100, ValidationRules.NUMBER)).toBe(-100);
    });

    test('returns 0 unchanged', () => {
      expect(validateInput(0, ValidationRules.NUMBER)).toBe(0);
    });

    test('throws INVALID_NUMBER for NaN', () => {
      try {
        validateInput(NaN, ValidationRules.NUMBER);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        expect(e.extensions.code).toBe('INVALID_NUMBER');
      }
    });

    test('throws INVALID_NUMBER for Infinity', () => {
      expect(() => validateInput(Infinity, ValidationRules.NUMBER)).toThrow(GraphQLError);
    });

    test('throws NUMBER_OUT_OF_RANGE when above max', () => {
      const strictRule = { type: 'number', min: -10, max: 10 };
      try {
        validateInput(11, strictRule);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        expect(e.extensions.code).toBe('NUMBER_OUT_OF_RANGE');
      }
    });

    test('throws NUMBER_OUT_OF_RANGE when below min', () => {
      const strictRule = { type: 'number', min: 0, max: 100 };
      expect(() => validateInput(-1, strictRule)).toThrow(GraphQLError);
    });

    test('accepts number at boundary values', () => {
      const rule = { type: 'number', min: 0, max: 100 };
      expect(validateInput(0, rule)).toBe(0);
      expect(validateInput(100, rule)).toBe(100);
    });
  });

  describe('unknown type', () => {
    test('returns input unchanged for unknown rule type', () => {
      const customRule = { type: 'boolean', required: false };
      expect(validateInput(true, customRule)).toBe(true);
    });
  });
});
