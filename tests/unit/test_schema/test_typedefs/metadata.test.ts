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
  test('Metadata expose les douze colonnes de la spec §2.2 et labelFields, en camelCase', () => {
    const expected = [
      'name',
      'label',
      'sqlType',
      'isCategorical',
      'isPrimaryKey',
      'parentName',
      'labelFor',
      'labelFields',
      'unit',
      'displayFormat',
      'family',
      'description',
      'defaultAggregation',
      // Champ dérivé, résolu à la demande — pas une colonne de la table metadata
      'stats',
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
    // Les sept champs d'UI appartiennent au producteur : ils restent nullables
    for (const optional of [
      'parentName',
      'labelFor',
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
   * Verification that labelFields is a non-null list of non-null strings.
   */
  test('labelFields est une liste non nullable de chaînes non nullables', () => {
    expect(String(fields.labelFields.type)).toBe('[String!]!');
  });

  /**
   * Verification that defaultAggregation reuses the existing Aggregation enum.
   */
  test('defaultAggregation est typé par l’enum Aggregation', () => {
    expect(String(fields.defaultAggregation.type)).toBe('Aggregation');
  });

  /**
   * Verification that stats is an optional lazy field of type FieldStats.
   */
  test('stats est un champ FieldStats nullable, sans argument', () => {
    expect(String(fields.stats.type)).toBe('FieldStats');
    expect(fields.stats.args).toHaveLength(0);
  });

  /**
   * Verification that the internal scope fields are not part of the SDL.
   */
  test('les champs internes _catalog et _schema ne sont pas exposés', () => {
    expect(fields).not.toHaveProperty('_catalog');
    expect(fields).not.toHaveProperty('_schema');
  });
});

// ─── Type FieldStats ─────────────────────────────────────────────────────────

describe('Object types — FieldStats', () => {
  let fields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(() => {
    fields = assertObjectType(schema.getType('FieldStats')).getFields();
  });

  test('expose min, max, distinctCount et nullCount', () => {
    expect(Object.keys(fields).sort()).toEqual(['distinctCount', 'max', 'min', 'nullCount']);
  });

  test('min et max sont des JSON nullables (colonne vide)', () => {
    expect(String(fields.min.type)).toBe('JSON');
    expect(String(fields.max.type)).toBe('JSON');
  });

  test('distinctCount et nullCount sont des Int non nullables', () => {
    expect(String(fields.distinctCount.type)).toBe('Int!');
    expect(String(fields.nullCount.type)).toBe('Int!');
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

  /**
   * Verification that getFieldStats takes a column, the routing and the filter tree.
   */
  test('getFieldStats retourne FieldStats! et accepte le même arbre de filtres que les faits', () => {
    expect(queryFields).toHaveProperty('getFieldStats');
    const field = queryFields.getFieldStats;

    expect(String(field.type)).toBe('FieldStats!');
    const args = Object.fromEntries(field.args.map((a) => [a.name, String(a.type)]));
    expect(args).toEqual({
      fieldName: 'String!',
      catalog: 'String',
      schema: 'String',
      structuredFilters: 'FilterNode',
    });
  });
});
