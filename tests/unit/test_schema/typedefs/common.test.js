import { schema } from '../../../src/schema/index.js';
import {
  assertObjectType,
  assertEnumType,
  assertInputObjectType,
  assertScalarType,
  isNonNullType,
} from 'graphql';

describe('Schema validity', () => {
  test('schema builds without errors', () => {
    expect(schema).toBeDefined();
  });

  test('schema exposes a Query type', () => {
    expect(schema.getQueryType()).toBeDefined();
  });

  test('schema exposes the JSON scalar', () => {
    expect(() => assertScalarType(schema.getType('JSON'))).not.toThrow();
  });
});

describe('Enums — common', () => {
  test('SortOrder has exactly ASC and DESC', () => {
    const type = assertEnumType(schema.getType('SortOrder'));
    const values = type.getValues().map(v => v.name);
    expect(values).toContain('ASC');
    expect(values).toContain('DESC');
    expect(values).toHaveLength(2);
  });

  test('Aggregation has all seven values', () => {
    const type = assertEnumType(schema.getType('Aggregation'));
    const values = type.getValues().map(v => v.name);
    for (const v of ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE']) {
      expect(values).toContain(v);
    }
    expect(values).toHaveLength(7);
  });
});

describe('Input types — common', () => {
  test('Filter input has key, operator, value, values fields', () => {
    const type = assertInputObjectType(schema.getType('Filter'));
    const fields = type.getFields();
    for (const f of ['key', 'operator', 'value', 'values']) {
      expect(fields).toHaveProperty(f);
    }
    expect(isNonNullType(fields.key.type)).toBe(true);
    expect(isNonNullType(fields.operator.type)).toBe(true);
  });

  test('SortInput has field (NonNull String) and order (SortOrder)', () => {
    const type = assertInputObjectType(schema.getType('SortInput'));
    const fields = type.getFields();
    expect(fields).toHaveProperty('field');
    expect(fields).toHaveProperty('order');
    expect(isNonNullType(fields.field.type)).toBe(true);
  });
});

describe('Object types — common', () => {
  test('AggregatedFact has key, aggregatedValue, count, keyLabel', () => {
    const fields = assertObjectType(schema.getType('AggregatedFact')).getFields();
    for (const f of ['key', 'aggregatedValue', 'count', 'keyLabel']) {
      expect(fields).toHaveProperty(f);
    }
  });

  test('SelectOption has non-null value and label', () => {
    const fields = assertObjectType(schema.getType('SelectOption')).getFields();
    expect(fields).toHaveProperty('value');
    expect(fields).toHaveProperty('label');
    expect(isNonNullType(fields.value.type)).toBe(true);
    expect(isNonNullType(fields.label.type)).toBe(true);
  });
});
