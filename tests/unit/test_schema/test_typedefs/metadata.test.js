import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, isNonNullType } from 'graphql';

describe('Object types — metadata', () => {
  test('Metadata has all six fields', () => {
    const fields = assertObjectType(schema.getType('Metadata')).getFields();
    for (const f of ['name', 'label', 'python_type', 'sql_type', 'is_categorical', 'is_primary_key']) {
      expect(fields).toHaveProperty(f);
    }
  });
});

describe('Query fields — metadata', () => {
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
});
