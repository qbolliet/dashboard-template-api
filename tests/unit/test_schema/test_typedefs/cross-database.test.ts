/**
 * Tests for the cross-database GraphQL type definitions.
 *
 * Validates the ComparedFact and PaginatedComparedFacts object types, and the
 * cross-database query fields: compareFacts, compareAggregatedFacts, and
 * crossDatabaseSelectOptions.
 */

import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, isNonNullType, GraphQLFieldMap } from 'graphql';

// ─── Types objet — cross-database ────────────────────────────────────────────

describe('Object types — cross-database', () => {
  /**
   * Verification that ComparedFact exposes all comparison fields.
   */
  test('ComparedFact has key, valueA, valueB, delta, deltaPercent (no keyLabel)', () => {
    // Extraction des champs du type ComparedFact
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('ComparedFact'),
    ).getFields();

    // Présence des champs de comparaison attendus
    for (const f of ['key', 'valueA', 'valueB', 'delta', 'deltaPercent']) {
      expect(fields).toHaveProperty(f);
    }

    // Caractère non-null de la clé d'identification
    expect(isNonNullType(fields.key.type)).toBe(true);
  });

  /**
   * Verification that PaginatedComparedFacts exposes all pagination fields.
   */
  test('PaginatedComparedFacts has data, measure, aggregation and the pagination fields', () => {
    // Extraction des champs du type paginé
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('PaginatedComparedFacts'),
    ).getFields();

    // Présence des champs de pagination
    for (const f of [
      'data',
      'measure',
      'aggregation',
      'total',
      'hasNextPage',
      'currentPage',
      'totalPages',
    ]) {
      expect(fields).toHaveProperty(f);
    }
  });
});

// ─── Champs de la Query — cross-database ─────────────────────────────────────

describe('Query fields — cross-database', () => {
  // Référence aux champs de la Query, initialisée avant tous les tests
  let queryFields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(() => {
    queryFields = schema.getQueryType()!.getFields();
  });

  /**
   * Verification that compareFacts requires catalogA, catalogB, and joinFields.
   */
  test('compareFacts has catalogA, catalogB, joinFields (all NonNull)', () => {
    expect(queryFields).toHaveProperty('compareFacts');

    // Validation du caractère obligatoire de chaque argument de jointure
    for (const argName of ['catalogA', 'catalogB', 'joinFields']) {
      const arg = queryFields.compareFacts.args.find((a) => a.name === argName);
      expect(arg).toBeDefined();

      // Argument obligatoire — contrainte NonNull
      expect(isNonNullType(arg!.type)).toBe(true);
    }
  });

  /**
   * Verification that compareFacts takes an optional measure and aggregation.
   */
  test('compareFacts has optional measure and aggregation args', () => {
    for (const argName of ['measure', 'aggregation']) {
      const arg = queryFields.compareFacts.args.find((a) => a.name === argName);
      expect(arg).toBeDefined();
      expect(isNonNullType(arg!.type)).toBe(false);
    }
  });

  /**
   * Verification that compareAggregatedFacts takes the inputs of getAggregates
   * and returns an AggregateComparison.
   */
  test('compareAggregatedFacts has groupBy, aggregates and sort args of getAggregates', () => {
    expect(queryFields).toHaveProperty('compareAggregatedFacts');
    const args = queryFields.compareAggregatedFacts.args;
    const typeOf = (name: string): string => String(args.find((a) => a.name === name)!.type);

    expect(typeOf('groupBy')).toBe('[GroupByInput!]');
    expect(typeOf('aggregates')).toBe('[AggregateInput!]!');
    expect(typeOf('sort')).toBe('[AggregateSortInput!]');
    expect(args.find((a) => a.name === 'aggregation')).toBeUndefined();
    expect(String(queryFields.compareAggregatedFacts.type)).toBe('AggregateComparison!');

    const fields = assertObjectType(schema.getType('AggregateComparison')).getFields();
    for (const f of ['groupBy', 'aggregates', 'columns', 'data', 'total', 'hasNextPage']) {
      expect(fields).toHaveProperty(f);
    }
    expect(String(fields.aggregates.type)).toBe('[AggregateColumn!]!');
    expect(String(fields.data.type)).toBe('[JSON!]!');
  });

  /**
   * Verification that crossDatabaseSelectOptions accepts fieldName and catalogs args.
   */
  test('crossDatabaseSelectOptions has fieldName and catalogs args', () => {
    expect(queryFields).toHaveProperty('crossDatabaseSelectOptions');

    // Présence des arguments de sélection multi-catalogue
    expect(
      queryFields.crossDatabaseSelectOptions.args.find((a) => a.name === 'fieldName'),
    ).toBeDefined();
    expect(
      queryFields.crossDatabaseSelectOptions.args.find((a) => a.name === 'catalogs'),
    ).toBeDefined();
  });
});
