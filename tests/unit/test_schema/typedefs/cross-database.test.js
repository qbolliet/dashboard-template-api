import { schema } from '../../../src/schema/index.js';
import { assertObjectType, isNonNullType } from 'graphql';

describe('Object types — cross-database', () => {
  test('ComparedFact has key, keyLabel, valueA, valueB, delta, deltaPercent', () => {
    const fields = assertObjectType(schema.getType('ComparedFact')).getFields();
    for (const f of ['key', 'keyLabel', 'valueA', 'valueB', 'delta', 'deltaPercent']) {
      expect(fields).toHaveProperty(f);
    }
    expect(isNonNullType(fields.key.type)).toBe(true);
  });

  test('PaginatedComparedFacts has data, total, hasNextPage, currentPage, totalPages', () => {
    const fields = assertObjectType(schema.getType('PaginatedComparedFacts')).getFields();
    for (const f of ['data', 'total', 'hasNextPage', 'currentPage', 'totalPages']) {
      expect(fields).toHaveProperty(f);
    }
  });
});

describe('Query fields — cross-database', () => {
  let queryFields;

  beforeAll(() => {
    queryFields = schema.getQueryType().getFields();
  });

  test('compareFacts has databaseA, databaseB, joinFields (all NonNull)', () => {
    expect(queryFields).toHaveProperty('compareFacts');
    for (const argName of ['databaseA', 'databaseB', 'joinFields']) {
      const arg = queryFields.compareFacts.args.find(a => a.name === argName);
      expect(arg).toBeDefined();
      expect(isNonNullType(arg.type)).toBe(true);
    }
  });

  test('compareAggregatedFacts has groupBy and aggregation args', () => {
    expect(queryFields).toHaveProperty('compareAggregatedFacts');
    expect(queryFields.compareAggregatedFacts.args.find(a => a.name === 'groupBy')).toBeDefined();
    expect(queryFields.compareAggregatedFacts.args.find(a => a.name === 'aggregation')).toBeDefined();
  });

  test('crossDatabaseSelectOptions has fieldName and databases args', () => {
    expect(queryFields).toHaveProperty('crossDatabaseSelectOptions');
    expect(queryFields.crossDatabaseSelectOptions.args.find(a => a.name === 'fieldName')).toBeDefined();
    expect(queryFields.crossDatabaseSelectOptions.args.find(a => a.name === 'databases')).toBeDefined();
  });
});
