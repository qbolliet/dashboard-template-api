import { schema } from '../../../../src/schema/index.js';
import {
  assertObjectType,
  assertEnumType,
  isNonNullType,
  isNamedType,
} from 'graphql';

describe('Enums — fact', () => {
  test('DataFormat has OBJECTS and ARRAYS', () => {
    const type = assertEnumType(schema.getType('DataFormat'));
    const values = type.getValues().map(v => v.name);
    expect(values).toContain('OBJECTS');
    expect(values).toContain('ARRAYS');
    expect(values).toHaveLength(2);
  });
});

describe('Object types — fact', () => {
  test('DimensionDetail has non-null name, value, label', () => {
    const fields = assertObjectType(schema.getType('DimensionDetail')).getFields();
    for (const f of ['name', 'value', 'label']) {
      expect(fields).toHaveProperty(f);
      expect(isNonNullType(fields[f].type)).toBe(true);
    }
  });

  test('Fact has value and dimensionDetails', () => {
    const fields = assertObjectType(schema.getType('Fact')).getFields();
    expect(fields).toHaveProperty('value');
    expect(fields).toHaveProperty('dimensionDetails');
  });

  test('PaginatedFacts has data, total, hasNextPage, currentPage, totalPages', () => {
    const fields = assertObjectType(schema.getType('PaginatedFacts')).getFields();
    for (const f of ['data', 'total', 'hasNextPage', 'currentPage', 'totalPages']) {
      expect(fields).toHaveProperty(f);
    }
  });

  test('DatasetMetadata has count, extents, pagination and generatedAt fields', () => {
    const fields = assertObjectType(schema.getType('DatasetMetadata')).getFields();
    for (const f of ['count', 'extents', 'total', 'hasNextPage', 'currentPage', 'totalPages', 'generatedAt']) {
      expect(fields).toHaveProperty(f);
    }
  });

  test('DatasetWithMetadata has columns, data, metadata', () => {
    const fields = assertObjectType(schema.getType('DatasetWithMetadata')).getFields();
    for (const f of ['columns', 'data', 'metadata']) {
      expect(fields).toHaveProperty(f);
    }
  });

  test('AggregationStatistics has mean, median, stdDev, quartiles', () => {
    const fields = assertObjectType(schema.getType('AggregationStatistics')).getFields();
    for (const f of ['mean', 'median', 'stdDev', 'quartiles']) {
      expect(fields).toHaveProperty(f);
    }
  });

  test('AggregatedFactsMetadata has count, keyExtent, valueExtent, statistics, groupByFieldInfo, generatedAt', () => {
    const fields = assertObjectType(schema.getType('AggregatedFactsMetadata')).getFields();
    for (const f of ['count', 'keyExtent', 'valueExtent', 'statistics', 'groupByFieldInfo', 'generatedAt']) {
      expect(fields).toHaveProperty(f);
    }
  });

  test('AggregatedFactsWithMetadata has data and metadata', () => {
    const fields = assertObjectType(schema.getType('AggregatedFactsWithMetadata')).getFields();
    expect(fields).toHaveProperty('data');
    expect(fields).toHaveProperty('metadata');
  });
});

describe('Query fields — fact', () => {
  let queryFields;

  beforeAll(() => {
    queryFields = schema.getQueryType().getFields();
  });

  test('getFactTable exists with limit, offset, structuredFilters, sort, database args', () => {
    expect(queryFields).toHaveProperty('getFactTable');
    for (const arg of ['limit', 'offset', 'structuredFilters', 'sort', 'database']) {
      expect(queryFields.getFactTable.args.find(a => a.name === arg)).toBeDefined();
    }
  });

  test('getFactTableWithMetadata exists and has format arg defaulting to OBJECTS', () => {
    expect(queryFields).toHaveProperty('getFactTableWithMetadata');
    const formatArg = queryFields.getFactTableWithMetadata.args.find(a => a.name === 'format');
    expect(formatArg).toBeDefined();
    expect(formatArg.defaultValue).toBe('OBJECTS');
  });

  test('getAggregatedFacts exists with groupBy (NonNull) and aggregation args', () => {
    expect(queryFields).toHaveProperty('getAggregatedFacts');
    const groupByArg = queryFields.getAggregatedFacts.args.find(a => a.name === 'groupBy');
    expect(groupByArg).toBeDefined();
    expect(isNonNullType(groupByArg.type)).toBe(true);
    expect(queryFields.getAggregatedFacts.args.find(a => a.name === 'aggregation')).toBeDefined();
  });

  test('getAggregatedFactsWithMetadata returns AggregatedFactsWithMetadata', () => {
    expect(queryFields).toHaveProperty('getAggregatedFactsWithMetadata');
    const returnType = queryFields.getAggregatedFactsWithMetadata.type;
    expect(isNamedType(returnType) ? returnType.name : returnType.ofType?.name).toBe('AggregatedFactsWithMetadata');
  });
});
