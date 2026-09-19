/**
 * Unit tests for validateIdentifier (src/utils/utils.ts).
 *
 * Verifies identifier validation rules and that rejections are reported as
 * GraphQL BAD_USER_INPUT errors. WHERE clause generation is covered by
 * filter-tree.test.ts.
 */

// Importation directe — pas de dépendances à mocker.
import { GraphQLError } from 'graphql';
import { validateIdentifier } from '../../../src/utils/utils.js';

// ─── validateIdentifier ───────────────────────────────────────────────────────

describe('validateIdentifier', () => {
  test('accepts valid identifiers', () => {
    expect(validateIdentifier('field_name')).toBe('field_name');
    expect(validateIdentifier('FieldName123')).toBe('FieldName123');
    expect(validateIdentifier('_private')).toBe('_private');
    expect(validateIdentifier('a')).toBe('a');
  });

  test('rejects identifiers starting with a digit', () => {
    expect(() => validateIdentifier('123field')).toThrow('Invalid field name');
  });

  test('rejects identifiers with hyphens', () => {
    expect(() => validateIdentifier('field-name')).toThrow('Invalid field name');
  });

  test('rejects identifiers with dots', () => {
    expect(() => validateIdentifier('field.name')).toThrow('Invalid field name');
  });

  test('rejects identifiers with spaces', () => {
    expect(() => validateIdentifier('field name')).toThrow('Invalid field name');
  });

  test('rejects empty string', () => {
    expect(() => validateIdentifier('')).toThrow('Invalid field name');
  });

  test('rejects non-string input', () => {
    // Entrées non-string — doivent lever une erreur quel que soit le type.
    expect(() => validateIdentifier(null as unknown as string)).toThrow();
    expect(() => validateIdentifier(42 as unknown as string)).toThrow();
  });

  test('includes the context in the error message', () => {
    // Contexte optionnel — enrichit le message d'erreur pour le débogage.
    expect(() => validateIdentifier('bad-name', 'filter key')).toThrow('Invalid filter key name');
  });

  test('includes the invalid name in the error message', () => {
    expect(() => validateIdentifier('bad-name')).toThrow('"bad-name"');
  });

  test('rejects SQL injection attempts', () => {
    expect(() => validateIdentifier('a; DROP TABLE fact_table')).toThrow('Invalid field name');
    expect(() => validateIdentifier('a" OR 1=1 --')).toThrow('Invalid field name');
  });

  test('throws a GraphQLError flagged BAD_USER_INPUT', () => {
    // Erreur client explicite — ne doit pas être masquée par les loaders
    let caught: unknown;
    try {
      validateIdentifier('bad-name');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
  });
});
