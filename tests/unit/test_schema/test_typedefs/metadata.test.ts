/**
 * Tests for the metadata GraphQL type definitions.
 *
 * Validates the Metadata object type and the getMetaData query field
 * with its required name argument.
 */

import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, isNonNullType, GraphQLFieldMap } from 'graphql';

// ─── Types objet — metadata ───────────────────────────────────────────────────

describe('Object types — metadata', () => {
  /**
   * Verification that Metadata exposes all six expected fields.
   */
  test('Metadata has all six fields', () => {
    // Extraction des champs du type Metadata
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('Metadata')
    ).getFields();

    // Présence des six champs descriptifs de colonne
    for (const f of [
      'name',
      'label',
      'python_type',
      'sql_type',
      'is_categorical',
      'is_primary_key',
    ]) {
      expect(fields).toHaveProperty(f);
    }
  });
});

// ─── Champs de la Query — metadata ───────────────────────────────────────────

describe('Query fields — metadata', () => {
  // Référence aux champs de la Query, initialisée avant tous les tests
  let queryFields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(() => {
    queryFields = schema.getQueryType()!.getFields();
  });

  /**
   * Verification that getMetaData exists with a required name argument.
   */
  test('getMetaData exists with required name arg', () => {
    expect(queryFields).toHaveProperty('getMetaData');

    // Recherche de l'argument identifiant obligatoire
    const nameArg = queryFields.getMetaData.args.find((a) => a.name === 'name');
    expect(nameArg).toBeDefined();

    // Caractère non-null de l'argument name
    expect(isNonNullType(nameArg!.type)).toBe(true);
  });
});
