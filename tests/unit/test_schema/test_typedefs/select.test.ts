/**
 * Tests for the select GraphQL type definitions.
 *
 * Validates the GroupedSelectOptions object type and the select-related query
 * fields: getSelectOptions and getGroupedSelectOptions with their argument signatures.
 */

import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, isNonNullType, GraphQLFieldMap } from 'graphql';

// ─── Types objet — select ─────────────────────────────────────────────────────

describe('Object types — select', () => {
  /**
   * Verification that GroupedSelectOptions exposes group and options fields.
   */
  test('GroupedSelectOptions has group and options arrays', () => {
    // Extraction des champs du type GroupedSelectOptions
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('GroupedSelectOptions')
    ).getFields();

    // Présence des champs de regroupement et d'options
    expect(fields).toHaveProperty('group');
    expect(fields).toHaveProperty('options');
  });
});

// ─── Champs de la Query — select ─────────────────────────────────────────────

describe('Query fields — select', () => {
  // Référence aux champs de la Query, initialisée avant tous les tests
  let queryFields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(() => {
    queryFields = schema.getQueryType()!.getFields();
  });

  /**
   * Verification that getSelectOptions requires a non-null fieldName argument.
   */
  test('getSelectOptions exists with fieldName (NonNull) arg', () => {
    expect(queryFields).toHaveProperty('getSelectOptions');

    // Recherche de l'argument de nom de champ obligatoire
    const fieldNameArg = queryFields.getSelectOptions.args.find(
      (a) => a.name === 'fieldName'
    );
    expect(fieldNameArg).toBeDefined();

    // Caractère non-null de l'argument fieldName
    expect(isNonNullType(fieldNameArg!.type)).toBe(true);
  });

  /**
   * Verification that getGroupedSelectOptions requires both groupField and optionsField.
   */
  test('getGroupedSelectOptions has groupField and optionsField (NonNull) args', () => {
    expect(queryFields).toHaveProperty('getGroupedSelectOptions');

    // Validation du caractère obligatoire de chaque argument de regroupement
    for (const argName of ['groupField', 'optionsField']) {
      const arg = queryFields.getGroupedSelectOptions.args.find(
        (a) => a.name === argName
      );
      expect(arg).toBeDefined();

      // Argument obligatoire — contrainte NonNull
      expect(isNonNullType(arg!.type)).toBe(true);
    }
  });
});
