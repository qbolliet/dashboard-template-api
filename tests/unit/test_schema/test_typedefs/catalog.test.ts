/**
 * Tests for the catalog GraphQL type definitions.
 *
 * Validates the DatabaseInfo object type and the catalog-related query fields
 * exposed by the schema: getDatabases, getDatabaseSchema, and getSharedDimensions.
 */

import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, isNonNullType, GraphQLFieldMap } from 'graphql';

// ─── Types objet — catalog ────────────────────────────────────────────────────

describe('Object types — catalog', () => {
  /**
   * Verification that DatabaseInfo exposes the expected fields.
   */
  test('DatabaseInfo has id, fields, dimensionNames', () => {
    // Extraction des champs du type DatabaseInfo
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('DatabaseInfo')
    ).getFields();

    // Présence des champs obligatoires
    for (const f of ['id', 'fields', 'dimensionNames']) {
      expect(fields).toHaveProperty(f);
    }

    // Caractère non-null du champ identifiant
    expect(isNonNullType(fields.id.type)).toBe(true);
  });
});

// ─── Champs de la Query — catalog ────────────────────────────────────────────

describe('Query fields — catalog', () => {
  // Référence aux champs de la Query, initialisée avant tous les tests
  let queryFields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(() => {
    queryFields = schema.getQueryType()!.getFields();
  });

  /**
   * Verification that getDatabases is present and returns a non-null list.
   */
  test('getDatabases returns a non-null list', () => {
    expect(queryFields).toHaveProperty('getDatabases');

    // Caractère non-null du type de retour
    expect(isNonNullType(queryFields.getDatabases.type)).toBe(true);
  });

  /**
   * Verification that getDatabaseSchema accepts an optional database argument.
   */
  test('getDatabaseSchema has optional database arg', () => {
    expect(queryFields).toHaveProperty('getDatabaseSchema');

    // Recherche de l'argument database
    const dbArg = queryFields.getDatabaseSchema.args.find(
      (a) => a.name === 'database'
    );
    expect(dbArg).toBeDefined();

    // Argument optionnel — pas de contrainte NonNull
    expect(isNonNullType(dbArg!.type)).toBe(false);
  });

  /**
   * Verification that getSharedDimensions requires a non-null databases list.
   */
  test('getSharedDimensions has required databases list arg', () => {
    expect(queryFields).toHaveProperty('getSharedDimensions');

    // Recherche de l'argument databases
    const dbsArg = queryFields.getSharedDimensions.args.find(
      (a) => a.name === 'databases'
    );
    expect(dbsArg).toBeDefined();

    // Argument obligatoire — contrainte NonNull
    expect(isNonNullType(dbsArg!.type)).toBe(true);
  });
});
