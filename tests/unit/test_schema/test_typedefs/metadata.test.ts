/**
 * Tests for the metadata GraphQL type definitions.
 *
 * Validates the Metadata object type — the full eleven-column contract of
 * specification-bdd.md §2.2, in camelCase, with the NOT NULL columns
 * non-nullable — and the getMetaData query field with its required name
 * argument.
 */

import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, isNonNullType, GraphQLFieldMap } from 'graphql';

// ─── Types objet — metadata ───────────────────────────────────────────────────

describe('Object types — metadata', () => {
  // Référence aux champs du type Metadata, initialisée avant tous les tests
  let fields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(() => {
    fields = assertObjectType(schema.getType('Metadata')).getFields();
  });

  /**
   * Verification that Metadata exposes the eleven columns of the contract.
   */
  test('Metadata expose les onze colonnes de la spec §2.2, en camelCase', () => {
    const expected = [
      'name',
      'label',
      'sqlType',
      'isCategorical',
      'isPrimaryKey',
      'parentName',
      'unit',
      'displayFormat',
      'family',
      'description',
      'defaultAggregation',
    ];
    expect(Object.keys(fields).sort()).toEqual([...expected].sort());
  });

  /**
   * Verification that no snake_case field survived the camelCase migration.
   */
  test('aucun champ snake_case ne subsiste', () => {
    // python_type n'existe plus dans la base (redondant avec sqlType)
    for (const legacy of ['sql_type', 'is_categorical', 'is_primary_key', 'python_type']) {
      expect(fields).not.toHaveProperty(legacy);
    }
  });

  /**
   * Verification that the NOT NULL columns of the database are non-nullable.
   */
  test('les colonnes NOT NULL de la base sont non-nullables', () => {
    for (const required of ['name', 'label', 'sqlType', 'isCategorical', 'isPrimaryKey']) {
      expect(isNonNullType(fields[required].type)).toBe(true);
    }
    // Les six champs d'UI appartiennent au producteur : ils restent nullables
    for (const optional of [
      'parentName',
      'unit',
      'displayFormat',
      'family',
      'description',
      'defaultAggregation',
    ]) {
      expect(isNonNullType(fields[optional].type)).toBe(false);
    }
  });

  /**
   * Verification that defaultAggregation reuses the existing Aggregation enum.
   */
  test('defaultAggregation est typé par l’enum Aggregation', () => {
    expect(String(fields.defaultAggregation.type)).toBe('Aggregation');
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
