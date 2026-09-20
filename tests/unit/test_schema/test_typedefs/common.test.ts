/**
 * Tests for the common GraphQL type definitions.
 *
 * Validates the schema-level invariants (existence, Query type, JSON scalar),
 * the shared enums (SortOrder, Aggregation, FilterConnector, FilterOperation),
 * input types (FilterNode, FilterCriterion, SortInput),
 * and common object types (AggregatedFact, SelectOption).
 */

import { schema } from '../../../../src/schema/index.js';
import {
  assertObjectType,
  assertEnumType,
  assertInputObjectType,
  assertScalarType,
  isNonNullType,
  GraphQLFieldMap,
} from 'graphql';

// ─── Validité du schéma ───────────────────────────────────────────────────────

describe('Schema validity', () => {
  /**
   * Verification that the schema was built successfully.
   */
  test('schema builds without errors', () => {
    expect(schema).toBeDefined();
  });

  /**
   * Verification that the schema exposes a Query root type.
   */
  test('schema exposes a Query type', () => {
    expect(schema.getQueryType()).toBeDefined();
  });

  /**
   * Verification that the JSON custom scalar is registered.
   */
  test('schema exposes the JSON scalar', () => {
    expect(() => assertScalarType(schema.getType('JSON'))).not.toThrow();
  });
});

// ─── Enums — communs ──────────────────────────────────────────────────────────

describe('Enums — common', () => {
  /**
   * Verification that SortOrder contains exactly ASC and DESC.
   */
  test('SortOrder has exactly ASC and DESC', () => {
    const type = assertEnumType(schema.getType('SortOrder'));

    // Extraction des noms de valeurs de l'enum
    const values: string[] = type.getValues().map((v) => v.name);

    expect(values).toContain('ASC');
    expect(values).toContain('DESC');

    // Nombre exact de valeurs attendues
    expect(values).toHaveLength(2);
  });

  /**
   * Verification that Aggregation exposes all seven aggregation functions.
   */
  test('Aggregation has all seven values', () => {
    const type = assertEnumType(schema.getType('Aggregation'));

    // Extraction des noms de valeurs de l'enum
    const values: string[] = type.getValues().map((v) => v.name);

    // Présence de chaque fonction d'agrégation
    for (const v of ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE']) {
      expect(values).toContain(v);
    }

    // Nombre exact de valeurs attendues
    expect(values).toHaveLength(7);
  });
});

// ─── Types Input — communs ────────────────────────────────────────────────────

describe('Input types — common', () => {
  /**
   * Verification that the legacy flat Filter input has been removed.
   */
  test('legacy Filter input no longer exists', () => {
    expect(schema.getType('Filter')).toBeUndefined();
  });

  /**
   * Verification that FilterCriterion has variable/operation (NonNull) and a JSON value.
   */
  test('FilterCriterion has variable, operation (NonNull) and value (JSON)', () => {
    const fields = assertInputObjectType(schema.getType('FilterCriterion')).getFields();

    expect(isNonNullType(fields.variable.type)).toBe(true);
    expect(isNonNullType(fields.operation.type)).toBe(true);
    expect(String(fields.operation.type)).toBe('FilterOperation!');
    expect(String(fields.value.type)).toBe('JSON');
  });

  /**
   * Verification that FilterNode is recursive with optional connector/criterion/children.
   */
  test('FilterNode has connector, criterion and recursive children', () => {
    const fields = assertInputObjectType(schema.getType('FilterNode')).getFields();

    expect(String(fields.connector.type)).toBe('FilterConnector');
    expect(String(fields.negate.type)).toBe('Boolean');
    expect(fields.negate.defaultValue).toBe(false);
    expect(String(fields.criterion.type)).toBe('FilterCriterion');
    expect(String(fields.children.type)).toBe('[FilterNode!]');
  });

  /**
   * Verification of the FilterConnector and FilterOperation enum values.
   */
  test('FilterConnector and FilterOperation expose the contract values', () => {
    const connectors = assertEnumType(schema.getType('FilterConnector'))
      .getValues()
      .map((v) => v.name);
    expect(connectors).toEqual(['AND', 'OR']);

    const operations = assertEnumType(schema.getType('FilterOperation'))
      .getValues()
      .map((v) => v.name);
    expect(operations).toEqual([
      'EQ',
      'NEQ',
      'GT',
      'GTE',
      'LT',
      'LTE',
      'BETWEEN',
      'NOT_BETWEEN',
      'IN',
      'NOT_IN',
      'BEFORE',
      'AFTER',
      'ON_OR_BEFORE',
      'ON_OR_AFTER',
      'CONTAINS',
      'NOT_CONTAINS',
      'STARTS',
      'NOT_STARTS',
      'ENDS',
      'NOT_ENDS',
      'IEQ',
      'ICONTAINS',
      'ISTARTS',
      'IENDS',
      'MATCHES',
      'IS_NULL',
      'IS_NOT_NULL',
      'IS_TRUE',
      'IS_FALSE',
      'IS_NOT_TRUE',
      'IS_NOT_FALSE',
    ]);
  });

  /**
   * Verification that SortInput has a non-null field and an order of type SortOrder.
   */
  test('SortInput has field (NonNull String) and order (SortOrder)', () => {
    // Extraction des champs du type Input SortInput
    const type = assertInputObjectType(schema.getType('SortInput'));
    const fields = type.getFields();

    expect(fields).toHaveProperty('field');
    expect(fields).toHaveProperty('order');

    // Caractère non-null du champ field
    expect(isNonNullType(fields.field.type)).toBe(true);
  });
});

// ─── Types objet — communs ────────────────────────────────────────────────────

describe('Object types — common', () => {
  /**
   * Verification that AggregatedFact exposes all expected fields.
   */
  test('AggregatedFact has key, aggregatedValue, count, keyLabel', () => {
    // Extraction des champs du type AggregatedFact
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('AggregatedFact'),
    ).getFields();

    // Présence des champs métier attendus
    for (const f of ['key', 'aggregatedValue', 'count', 'keyLabel']) {
      expect(fields).toHaveProperty(f);
    }
  });

  /**
   * Verification that SelectOption has non-null value and label.
   */
  test('SelectOption has non-null value and label', () => {
    // Extraction des champs du type SelectOption
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('SelectOption'),
    ).getFields();

    expect(fields).toHaveProperty('value');
    expect(fields).toHaveProperty('label');

    // Caractère non-null des deux champs obligatoires
    expect(isNonNullType(fields.value.type)).toBe(true);
    expect(isNonNullType(fields.label.type)).toBe(true);
  });
});
