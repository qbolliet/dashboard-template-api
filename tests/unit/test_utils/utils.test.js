// Unit tests for validateIdentifier and buildWhereClause (src/utils/utils.js)
import { validateIdentifier, buildWhereClause } from '../../../src/utils/utils.js';

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
    expect(() => validateIdentifier(null)).toThrow();
    expect(() => validateIdentifier(42)).toThrow();
  });

  test('includes the context in the error message', () => {
    expect(() => validateIdentifier('bad-name', 'filter key')).toThrow('Invalid filter key name');
  });

  test('includes the invalid name in the error message', () => {
    expect(() => validateIdentifier('bad-name')).toThrow('"bad-name"');
  });
});

describe('buildWhereClause', () => {
  test('returns empty string when no filters provided', () => {
    expect(buildWhereClause(null, null)).toBe('');
    expect(buildWhereClause('', [])).toBe('');
    expect(buildWhereClause(null, [])).toBe('');
  });

  test('wraps raw filter string with WHERE', () => {
    expect(buildWhereClause('age > 18', null)).toBe('WHERE (age > 18)');
  });

  test('builds WHERE from a single structured filter with string value', () => {
    const filters = [{ key: 'status', operator: '=', value: 'active' }];
    expect(buildWhereClause(null, filters)).toBe("WHERE status = 'active'");
  });

  test('omits quotes for numeric string values', () => {
    const filters = [{ key: 'age', operator: '>', value: '30' }];
    expect(buildWhereClause(null, filters)).toBe('WHERE age > 30');
  });

  test('omits quotes for boolean string values', () => {
    const filtersTrue = [{ key: 'active', operator: '=', value: 'true' }];
    expect(buildWhereClause(null, filtersTrue)).toBe('WHERE active = true');
    const filtersFalse = [{ key: 'active', operator: '=', value: 'false' }];
    expect(buildWhereClause(null, filtersFalse)).toBe('WHERE active = false');
  });

  test('handles IN operator with string values', () => {
    const filters = [{ key: 'status', operator: 'IN', values: ['active', 'pending'] }];
    expect(buildWhereClause(null, filters)).toBe("WHERE status IN ('active', 'pending')");
  });

  test('handles NOT IN operator', () => {
    const filters = [{ key: 'status', operator: 'NOT IN', values: ['deleted', 'archived'] }];
    expect(buildWhereClause(null, filters)).toBe("WHERE status NOT IN ('deleted', 'archived')");
  });

  test('handles IN operator with numeric values (no quotes)', () => {
    const filters = [{ key: 'id', operator: 'IN', values: ['1', '2', '3'] }];
    expect(buildWhereClause(null, filters)).toBe('WHERE id IN (1, 2, 3)');
  });

  test('handles IN operator with null values', () => {
    const filters = [{ key: 'status', operator: 'IN', values: [null, 'active'] }];
    const result = buildWhereClause(null, filters);
    expect(result).toContain('NULL');
    expect(result).toContain("'active'");
  });

  test('handles operator without value (IS NULL)', () => {
    const filters = [{ key: 'status', operator: 'IS NULL' }];
    expect(buildWhereClause(null, filters)).toBe('WHERE status IS NULL');
  });

  test('joins multiple structured filters with AND', () => {
    const filters = [
      { key: 'status', operator: '=', value: 'active' },
      { key: 'age', operator: '>', value: '18' },
    ];
    expect(buildWhereClause(null, filters)).toBe("WHERE status = 'active' AND age > 18");
  });

  test('combines raw filter and structured filters with AND', () => {
    const filters = [{ key: 'status', operator: '=', value: 'active' }];
    expect(buildWhereClause('age > 18', filters)).toBe(
      "WHERE (age > 18) AND (status = 'active')"
    );
  });

  test('escapes single quotes in string values', () => {
    const filters = [{ key: 'name', operator: '=', value: "O'Brien" }];
    expect(buildWhereClause(null, filters)).toBe("WHERE name = 'O''Brien'");
  });

  test('escapes single quotes in IN values', () => {
    const filters = [{ key: 'name', operator: 'IN', values: ["O'Brien", "O'Connor"] }];
    const result = buildWhereClause(null, filters);
    expect(result).toContain("'O''Brien'");
    expect(result).toContain("'O''Connor'");
  });

  test('throws for an invalid identifier as filter key', () => {
    const filters = [{ key: 'bad-key', operator: '=', value: 'test' }];
    expect(() => buildWhereClause(null, filters)).toThrow('Invalid filter key name');
  });
});
