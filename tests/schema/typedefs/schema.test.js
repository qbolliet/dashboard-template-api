import { schema } from '../../../src/schema/index.js';
import {
  assertObjectType,
  assertEnumType,
  assertInputObjectType,
  assertScalarType,
  isNonNullType,
  isListType,
  isNamedType,
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

describe('Enums', () => {
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

  test('DataFormat has OBJECTS and ARRAYS', () => {
    const type = assertEnumType(schema.getType('DataFormat'));
    const values = type.getValues().map(v => v.name);
    expect(values).toContain('OBJECTS');
    expect(values).toContain('ARRAYS');
    expect(values).toHaveLength(2);
  });
});

describe('Input types', () => {
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

describe('Object types', () => {
  test('Metadata has all six fields', () => {
    const fields = assertObjectType(schema.getType('Metadata')).getFields();
    for (const f of ['name', 'label', 'python_type', 'sql_type', 'is_categorical', 'is_primary_key']) {
      expect(fields).toHaveProperty(f);
    }
  });

  test('Dimension has value and label fields', () => {
    const fields = assertObjectType(schema.getType('Dimension')).getFields();
    expect(fields).toHaveProperty('value');
    expect(fields).toHaveProperty('label');
  });

  test('SelectOption has non-null value and label', () => {
    const fields = assertObjectType(schema.getType('SelectOption')).getFields();
    expect(fields).toHaveProperty('value');
    expect(fields).toHaveProperty('label');
    expect(isNonNullType(fields.value.type)).toBe(true);
    expect(isNonNullType(fields.label.type)).toBe(true);
  });

  test('GroupedSelectOptions has group and options arrays', () => {
    const fields = assertObjectType(schema.getType('GroupedSelectOptions')).getFields();
    expect(fields).toHaveProperty('group');
    expect(fields).toHaveProperty('options');
  });

  test('AggregatedFact has key, aggregatedValue, count, keyLabel', () => {
    const fields = assertObjectType(schema.getType('AggregatedFact')).getFields();
    for (const f of ['key', 'aggregatedValue', 'count', 'keyLabel']) {
      expect(fields).toHaveProperty(f);
    }
  });

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

  test('DatasetMetadata has pagination and extent fields', () => {
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

  test('AggregatedFactsMetadata has count, keyExtent, valueExtent, statistics, groupByFieldInfo', () => {
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

  test('DatabaseInfo has id, fields, dimensionNames', () => {
    const fields = assertObjectType(schema.getType('DatabaseInfo')).getFields();
    for (const f of ['id', 'fields', 'dimensionNames']) {
      expect(fields).toHaveProperty(f);
    }
    expect(isNonNullType(fields.id.type)).toBe(true);
  });

  test('ComparedFact has key, valueA, valueB, delta, deltaPercent', () => {
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

describe('Query fields', () => {
  let queryFields;

  beforeAll(() => {
    queryFields = schema.getQueryType().getFields();
  });

  test('getMetaData exists with required name arg', () => {
    expect(queryFields).toHaveProperty('getMetaData');
    const nameArg = queryFields.getMetaData.args.find(a => a.name === 'name');
    expect(nameArg).toBeDefined();
    expect(isNonNullType(nameArg.type)).toBe(true);
  });

  test('getDimensionTable exists with name and optional database args', () => {
    expect(queryFields).toHaveProperty('getDimensionTable');
    expect(queryFields.getDimensionTable.args.find(a => a.name === 'name')).toBeDefined();
    expect(queryFields.getDimensionTable.args.find(a => a.name === 'database')).toBeDefined();
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

  test('getSelectOptions exists with fieldName (NonNull) arg', () => {
    expect(queryFields).toHaveProperty('getSelectOptions');
    const fieldNameArg = queryFields.getSelectOptions.args.find(a => a.name === 'fieldName');
    expect(fieldNameArg).toBeDefined();
    expect(isNonNullType(fieldNameArg.type)).toBe(true);
  });

  test('getGroupedSelectOptions has groupField and optionsField (NonNull) args', () => {
    expect(queryFields).toHaveProperty('getGroupedSelectOptions');
    for (const argName of ['groupField', 'optionsField']) {
      const arg = queryFields.getGroupedSelectOptions.args.find(a => a.name === argName);
      expect(arg).toBeDefined();
      expect(isNonNullType(arg.type)).toBe(true);
    }
  });

  test('getDatabases returns a non-null list', () => {
    expect(queryFields).toHaveProperty('getDatabases');
    expect(isNonNullType(queryFields.getDatabases.type)).toBe(true);
  });

  test('getDatabaseSchema has optional database arg', () => {
    expect(queryFields).toHaveProperty('getDatabaseSchema');
    const dbArg = queryFields.getDatabaseSchema.args.find(a => a.name === 'database');
    expect(dbArg).toBeDefined();
    expect(isNonNullType(dbArg.type)).toBe(false);
  });

  test('getSharedDimensions has required databases list arg', () => {
    expect(queryFields).toHaveProperty('getSharedDimensions');
    const dbsArg = queryFields.getSharedDimensions.args.find(a => a.name === 'databases');
    expect(dbsArg).toBeDefined();
    expect(isNonNullType(dbsArg.type)).toBe(true);
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
