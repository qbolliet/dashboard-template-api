import { schema } from '../../../src/schema/index.js';
import { assertObjectType } from 'graphql';

describe('Object types — dimension', () => {
  test('Dimension has value and label fields', () => {
    const fields = assertObjectType(schema.getType('Dimension')).getFields();
    expect(fields).toHaveProperty('value');
    expect(fields).toHaveProperty('label');
  });
});

describe('Query fields — dimension', () => {
  let queryFields;

  beforeAll(() => {
    queryFields = schema.getQueryType().getFields();
  });

  test('getDimensionTable exists with name and optional database args', () => {
    expect(queryFields).toHaveProperty('getDimensionTable');
    expect(queryFields.getDimensionTable.args.find(a => a.name === 'name')).toBeDefined();
    expect(queryFields.getDimensionTable.args.find(a => a.name === 'database')).toBeDefined();
  });
});
