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
  test('DatabaseInfo has id, schemas, fields, dimensionNames', () => {
    // Extraction des champs du type DatabaseInfo
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('DatabaseInfo'),
    ).getFields();

    // Présence des champs obligatoires (dont la liste des schémas pour l'introspection)
    for (const f of ['id', 'schemas', 'fields', 'dimensionNames']) {
      expect(fields).toHaveProperty(f);
    }

    // Caractère non-null du champ identifiant et de la liste des schémas
    expect(isNonNullType(fields.id.type)).toBe(true);
    expect(isNonNullType(fields.schemas.type)).toBe(true);
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
   * Verification that getDatabaseSchema accepts optional catalog and schema arguments.
   */
  test('getDatabaseSchema has optional catalog and schema args', () => {
    expect(queryFields).toHaveProperty('getDatabaseSchema');

    // Recherche de l'argument catalog
    const catalogArg = queryFields.getDatabaseSchema.args.find((a) => a.name === 'catalog');
    expect(catalogArg).toBeDefined();
    // Argument optionnel — pas de contrainte NonNull
    expect(isNonNullType(catalogArg!.type)).toBe(false);

    // Recherche de l'argument schema (nouveau, multi-schéma par catalogue)
    const schemaArg = queryFields.getDatabaseSchema.args.find((a) => a.name === 'schema');
    expect(schemaArg).toBeDefined();
    // Argument optionnel — schéma par défaut du catalogue utilisé quand absent
    expect(isNonNullType(schemaArg!.type)).toBe(false);
  });

  /**
   * Verification that getSharedDimensions requires a non-null catalogs list and
   * accepts an optional aligned schemas list.
   */
  test('getSharedDimensions has required catalogs and optional schemas args', () => {
    expect(queryFields).toHaveProperty('getSharedDimensions');

    // Argument catalogs obligatoire (liste non-null)
    const catalogsArg = queryFields.getSharedDimensions.args.find((a) => a.name === 'catalogs');
    expect(catalogsArg).toBeDefined();
    expect(isNonNullType(catalogsArg!.type)).toBe(true);

    // Argument schemas optionnel (aligné par index sur catalogs)
    const schemasArg = queryFields.getSharedDimensions.args.find((a) => a.name === 'schemas');
    expect(schemasArg).toBeDefined();
    expect(isNonNullType(schemasArg!.type)).toBe(false);
  });
});
