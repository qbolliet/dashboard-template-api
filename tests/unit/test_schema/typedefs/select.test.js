import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, isNonNullType } from 'graphql';

describe('Object types — select', () => {
  test('GroupedSelectOptions has group and options arrays', () => {
    const fields = assertObjectType(schema.getType('GroupedSelectOptions')).getFields();
    expect(fields).toHaveProperty('group');
    expect(fields).toHaveProperty('options');
  });
});

describe('Query fields — select', () => {
  let queryFields;

  beforeAll(() => {
    queryFields = schema.getQueryType().getFields();
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
});
