/**
 * Tests for the select GraphQL type definitions.
 *
 * Validates the select-related query fields: getSelectOptions and
 * getSelectOptionsTree with their argument signatures, and the removal of
 * getGroupedSelectOptions together with its GroupedSelectOptions type.
 */

import { schema } from '../../../../src/schema/index.js';
import { isNonNullType, isScalarType, getNullableType, GraphQLFieldMap } from 'graphql';

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
    const fieldNameArg = queryFields.getSelectOptions.args.find((a) => a.name === 'fieldName');
    expect(fieldNameArg).toBeDefined();

    // Caractère non-null de l'argument fieldName
    expect(isNonNullType(fieldNameArg!.type)).toBe(true);
  });

  /**
   * Verification of the getSelectOptionsTree signature and its JSON! return type.
   */
  test('getSelectOptionsTree exists with its arguments and returns JSON!', () => {
    expect(queryFields).toHaveProperty('getSelectOptionsTree');
    const field = queryFields.getSelectOptionsTree;

    // Seul fieldName est obligatoire
    const args = new Map(field.args.map((a) => [a.name, a]));
    expect([...args.keys()].sort()).toEqual(
      ['catalog', 'fieldName', 'maxDepth', 'schema', 'searchTerm'].sort(),
    );
    expect(isNonNullType(args.get('fieldName')!.type)).toBe(true);
    expect(isNonNullType(args.get('maxDepth')!.type)).toBe(false);
    // Pas de défaut SDL : maxDepth absent = toute la chaîne
    expect(args.get('maxDepth')!.defaultValue).toBeUndefined();

    // Forme hiérarchique unique : scalaire JSON non nul
    expect(isNonNullType(field.type)).toBe(true);
    const inner = getNullableType(field.type);
    expect(isScalarType(inner) && inner.name).toBe('JSON');

    // La description documente la forme et l'exemple group-options
    expect(field.description).toContain('children');
    expect(field.description).toContain('maxDepth: 2');
  });

  /**
   * Verification that the uncorrelated grouped query is gone, type included.
   */
  test('getGroupedSelectOptions and GroupedSelectOptions are removed', () => {
    expect(queryFields).not.toHaveProperty('getGroupedSelectOptions');
    expect(schema.getType('GroupedSelectOptions')).toBeUndefined();
  });
});
