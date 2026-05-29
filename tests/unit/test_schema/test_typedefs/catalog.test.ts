/**
 * Tests for the catalog GraphQL type definitions.
 *
 * Validates the Catalog object type, the CatalogSchemaInput input type,
 * and the catalog-related query fields exposed by the schema:
 * getCatalogs, getCatalogSchema, getFields, and getSharedDimensions.
 */

import { schema } from '../../../../src/schema/index.js';
import {
  assertObjectType,
  assertInputObjectType,
  isNonNullType,
  isListType,
  GraphQLFieldMap,
} from 'graphql';

// ─── Types objet — catalog ────────────────────────────────────────────────────

describe('Object types — catalog', () => {
  /**
   * Verification that Catalog exposes the expected fields.
   */
  test('Catalog has id, defaultSchema, schemas (all non-null)', () => {
    // Extraction des champs du type Catalog
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('Catalog'),
    ).getFields();

    // Présence des champs obligatoires
    for (const f of ['id', 'defaultSchema', 'schemas']) {
      expect(fields).toHaveProperty(f);
    }

    // Caractère non-null des trois champs (id, defaultSchema, schemas)
    expect(isNonNullType(fields.id.type)).toBe(true);
    expect(isNonNullType(fields.defaultSchema.type)).toBe(true);
    expect(isNonNullType(fields.schemas.type)).toBe(true);
  });

  /**
   * Verification that CatalogSchemaInfo exposes the lazy cascade fields.
   */
  test('CatalogSchemaInfo has name, fields, dimensionNames (all non-null)', () => {
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('CatalogSchemaInfo'),
    ).getFields();

    // Présence des champs : name + cascade lazy (fields, dimensionNames)
    for (const f of ['name', 'fields', 'dimensionNames']) {
      expect(fields).toHaveProperty(f);
    }

    expect(isNonNullType(fields.name.type)).toBe(true);
    expect(isNonNullType(fields.fields.type)).toBe(true);
    expect(isNonNullType(fields.dimensionNames.type)).toBe(true);
  });
});

// ─── Types input — catalog ────────────────────────────────────────────────────

describe('Input types — catalog', () => {
  /**
   * Verification that CatalogSchemaInput exposes a required catalog and an
   * optional schema field.
   */
  test('CatalogSchemaInput has required catalog and optional schema', () => {
    // Extraction des champs du type input CatalogSchemaInput
    const fields = assertInputObjectType(schema.getType('CatalogSchemaInput')).getFields();

    expect(fields).toHaveProperty('catalog');
    expect(fields).toHaveProperty('schema');

    // Catalog obligatoire, schema optionnel
    expect(isNonNullType(fields.catalog.type)).toBe(true);
    expect(isNonNullType(fields.schema.type)).toBe(false);
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
   * Verification that getCatalogs is present and returns a non-null list.
   */
  test('getCatalogs returns a non-null list', () => {
    expect(queryFields).toHaveProperty('getCatalogs');

    // Caractère non-null du type de retour
    expect(isNonNullType(queryFields.getCatalogs.type)).toBe(true);
  });

  /**
   * Verification that getCatalogSchema accepts optional catalog and schema arguments.
   */
  test('getCatalogSchema has optional catalog and schema args', () => {
    expect(queryFields).toHaveProperty('getCatalogSchema');

    // Recherche de l'argument catalog
    const catalogArg = queryFields.getCatalogSchema.args.find((a) => a.name === 'catalog');
    expect(catalogArg).toBeDefined();
    // Argument optionnel — pas de contrainte NonNull
    expect(isNonNullType(catalogArg!.type)).toBe(false);

    // Recherche de l'argument schema (multi-schéma par catalogue)
    const schemaArg = queryFields.getCatalogSchema.args.find((a) => a.name === 'schema');
    expect(schemaArg).toBeDefined();
    // Argument optionnel — schéma par défaut du catalogue utilisé quand absent
    expect(isNonNullType(schemaArg!.type)).toBe(false);
  });

  /**
   * Verification that getSharedDimensions takes a single required targets argument
   * typed as a non-null list of non-null CatalogSchemaInput.
   */
  test('getSharedDimensions has a single required targets arg', () => {
    expect(queryFields).toHaveProperty('getSharedDimensions');

    // Un seul argument exposé : targets
    const args = queryFields.getSharedDimensions.args.map((a) => a.name).sort();
    expect(args).toEqual(['targets']);

    // Argument targets obligatoire (liste non-null d'inputs non-null)
    const targetsArg = queryFields.getSharedDimensions.args.find((a) => a.name === 'targets')!;
    expect(isNonNullType(targetsArg.type)).toBe(true);

    // Le contenu de la liste est lui aussi non-null (CatalogSchemaInput!)
    const inner = (targetsArg.type as { ofType: unknown }).ofType;
    expect(isListType(inner)).toBe(true);
    const innerItem = (inner as { ofType: unknown }).ofType;
    expect(isNonNullType(innerItem)).toBe(true);
  });
});
