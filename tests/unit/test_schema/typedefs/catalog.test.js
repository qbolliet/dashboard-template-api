import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, isNonNullType } from 'graphql';

describe('Object types — catalog', () => {
  test('DatabaseInfo has id, fields, dimensionNames', () => {
    const fields = assertObjectType(schema.getType('DatabaseInfo')).getFields();
    for (const f of ['id', 'fields', 'dimensionNames']) {
      expect(fields).toHaveProperty(f);
    }
    expect(isNonNullType(fields.id.type)).toBe(true);
  });
});

describe('Query fields — catalog', () => {
  let queryFields;

  beforeAll(() => {
    queryFields = schema.getQueryType().getFields();
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
});
