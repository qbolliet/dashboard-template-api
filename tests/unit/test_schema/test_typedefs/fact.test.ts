/**
 * Tests for the fact GraphQL type definitions.
 *
 * Validates the DataFormat enum, all fact-related object types
 * (FieldValue, Fact, PaginatedFacts, DatasetMetadata, DatasetWithMetadata),
 * the fact query fields with their argument signatures, and the removal of the
 * former aggregated fact queries (replaced by getAggregates).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { schema } from '../../../../src/schema/index.js';
import {
  assertObjectType,
  assertEnumType,
  isNonNullType,
  isNamedType,
  GraphQLFieldMap,
} from 'graphql';

// Racine du dépôt, pour lire les sources des typedefs et le SDL versionné
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// ─── Enums — fact ─────────────────────────────────────────────────────────────

describe('Enums — fact', () => {
  /**
   * Verification that DataFormat contains exactly OBJECTS and ARRAYS.
   */
  test('DataFormat has OBJECTS and ARRAYS', () => {
    const type = assertEnumType(schema.getType('DataFormat'));

    // Extraction des noms de valeurs de l'enum
    const values: string[] = type.getValues().map((v) => v.name);

    expect(values).toContain('OBJECTS');
    expect(values).toContain('ARRAYS');

    // Nombre exact de valeurs attendues
    expect(values).toHaveLength(2);
  });
});

// ─── Types objet — fact ───────────────────────────────────────────────────────

describe('Object types — fact', () => {
  /**
   * Verification that Fact exposes keys and measures, both non-null lists.
   */
  test('Fact has keys and measures (no scalar value, no dimensionDetails)', () => {
    // Extraction des champs du type Fact
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('Fact'),
    ).getFields();

    expect(fields).toHaveProperty('keys');
    expect(fields).toHaveProperty('measures');
    // Le champ scalaire mono-mesure a été retiré au profit de measures
    expect(fields).not.toHaveProperty('value');
    // La couche dimension a disparu : plus de dimensionDetails
    expect(fields).not.toHaveProperty('dimensionDetails');
    // Les deux listes sont non-nullables
    expect(isNonNullType(fields.keys.type)).toBe(true);
    expect(isNonNullType(fields.measures.type)).toBe(true);
  });

  /**
   * Verification that the removed dimension types are gone from the schema.
   */
  test('DimensionDetail, Measure and Dimension no longer exist', () => {
    for (const typeName of ['DimensionDetail', 'Measure', 'Dimension']) {
      expect(schema.getType(typeName)).toBeUndefined();
    }
  });

  /**
   * Verification that FieldValue exposes name (non-null) and value (JSON).
   */
  test('FieldValue has non-null name and a value field', () => {
    // Extraction des champs du type FieldValue
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('FieldValue'),
    ).getFields();

    expect(fields).toHaveProperty('name');
    expect(isNonNullType(fields.name.type)).toBe(true);
    // La valeur reste nullable : une clé de hiérarchie absente vaut NULL
    expect(fields).toHaveProperty('value');
    expect(isNonNullType(fields.value.type)).toBe(false);
    // Pas de label dupliqué par colonne : la fact table porte le libellé
    expect(fields).not.toHaveProperty('label');
  });

  /**
   * Verification that PaginatedFacts exposes all pagination fields.
   */
  test('PaginatedFacts has data, total, hasNextPage, currentPage, totalPages', () => {
    // Extraction des champs du type paginé
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('PaginatedFacts'),
    ).getFields();

    // Présence des champs de pagination
    for (const f of ['data', 'total', 'hasNextPage', 'currentPage', 'totalPages']) {
      expect(fields).toHaveProperty(f);
    }
  });

  /**
   * Verification that DatasetMetadata exposes count, extents, pagination, and timestamp.
   */
  test('DatasetMetadata has count, extents, pagination and generatedAt fields', () => {
    // Extraction des champs du type de métadonnées dataset
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('DatasetMetadata'),
    ).getFields();

    // Présence des champs de métadonnées et de pagination
    for (const f of [
      'count',
      'extents',
      'total',
      'hasNextPage',
      'currentPage',
      'totalPages',
      'generatedAt',
    ]) {
      expect(fields).toHaveProperty(f);
    }
  });

  /**
   * Verification that DatasetWithMetadata exposes columns, data, and metadata.
   */
  test('DatasetWithMetadata has columns, data, metadata', () => {
    // Extraction des champs du type dataset enrichi
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('DatasetWithMetadata'),
    ).getFields();

    // Présence des champs structurels du dataset
    for (const f of ['columns', 'fields', 'data', 'metadata']) {
      expect(fields).toHaveProperty(f);
    }
  });

  /**
   * Verification that DatasetWithMetadata.fields is a non-null list of non-null
   * Metadata, and that extents documents the page scope.
   */
  test('DatasetWithMetadata.fields is [Metadata!]! and extents documents the page scope', () => {
    const dataset = assertObjectType(schema.getType('DatasetWithMetadata'));

    expect(String(dataset.getFields().fields.type)).toBe('[Metadata!]!');

    // Description SDL : bornes de la PAGE, renvoi vers Metadata.stats pour les globales
    const extents = assertObjectType(schema.getType('DatasetMetadata')).getFields().extents;
    expect(extents.description).toMatch(/this page/i);
    expect(extents.description).toMatch(/Metadata\.stats/);
  });

  /**
   * Verification that the JSON scalar documents the serialization rules.
   */
  test('JSON scalar documents the value serialization rules', () => {
    const description = schema.getType('JSON')?.description ?? '';

    for (const rule of ['Number.isSafeInteger', 'decimal string', 'YYYY-MM-DD', 'T separator']) {
      expect(description).toContain(rule);
    }
  });

  /**
   * Verification that row counters are Float (exact up to 2^53), not 32-bit Int.
   */
  test.each([
    ['PaginatedFacts', 'total', 'Float'],
    ['PaginatedFacts', 'totalPages', 'Float'],
    ['DatasetMetadata', 'total', 'Float'],
    ['DatasetMetadata', 'totalPages', 'Float'],
    ['PaginatedComparedFacts', 'total', 'Float!'],
    ['PaginatedComparedFacts', 'totalPages', 'Float!'],
    ['FieldStats', 'distinctCount', 'Float!'],
    ['FieldStats', 'nullCount', 'Float!'],
    ['AggregateResult', 'total', 'Float!'],
  ])('%s.%s is %s', (typeName, field, expected) => {
    const fields = assertObjectType(schema.getType(typeName)).getFields();

    expect(String(fields[field].type)).toBe(expected);
  });
});

// ─── Champs de la Query — fact ────────────────────────────────────────────────

describe('Query fields — fact', () => {
  // Référence aux champs de la Query, initialisée avant tous les tests
  let queryFields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(() => {
    queryFields = schema.getQueryType()!.getFields();
  });

  /**
   * Verification that getFactTable exists with all expected filter, pagination and routing args.
   */
  test('getFactTable exists with limit, offset, structuredFilters, sort, catalog, schema args', () => {
    expect(queryFields).toHaveProperty('getFactTable');

    // Présence de chaque argument de filtrage, pagination, et de routage multi-catalogue/schéma
    for (const arg of ['limit', 'offset', 'structuredFilters', 'sort', 'catalog', 'schema']) {
      expect(queryFields.getFactTable.args.find((a) => a.name === arg)).toBeDefined();
    }
  });

  /**
   * Verification that the raw SQL filters argument is gone and structuredFilters is a FilterNode.
   */
  test.each(['getFactTable', 'getFactTableWithMetadata', 'getAggregates'])(
    '%s has structuredFilters: FilterNode and no filters argument',
    (queryName) => {
      const args = queryFields[queryName].args;
      expect(args.find((a) => a.name === 'filters')).toBeUndefined();
      expect(String(args.find((a) => a.name === 'structuredFilters')!.type)).toBe('FilterNode');
    },
  );

  /**
   * Verification that getFactTableWithMetadata has a format arg defaulting to OBJECTS.
   */
  test('getFactTableWithMetadata exists and has format arg defaulting to OBJECTS', () => {
    expect(queryFields).toHaveProperty('getFactTableWithMetadata');

    // Recherche de l'argument de format de sortie
    const formatArg = queryFields.getFactTableWithMetadata.args.find((a) => a.name === 'format');
    expect(formatArg).toBeDefined();

    // Valeur par défaut du format de sérialisation
    expect(formatArg!.defaultValue).toBe('OBJECTS');
  });

  /**
   * Verification that the former aggregated fact queries and their types are gone.
   */
  test('getAggregatedFacts* and their types are removed, from the schema and the SDL', () => {
    expect(queryFields).not.toHaveProperty('getAggregatedFacts');
    expect(queryFields).not.toHaveProperty('getAggregatedFactsWithMetadata');

    const sdl = fs.readFileSync(path.join(ROOT, 'schema.graphql'), 'utf8');
    for (const type of [
      'AggregatedFact',
      'AggregatedFactsMetadata',
      'AggregatedFactsWithMetadata',
      'AggregationStatistics',
    ]) {
      expect(schema.getType(type)).toBeUndefined();
      expect(sdl).not.toMatch(new RegExp(`^type ${type} \\{`, 'm'));
    }
  });

  /**
   * Verification of the signature of getAggregates.
   */
  test('getAggregates: aggregates required, groupBy defaulting to [], non-null result', () => {
    const field = queryFields.getAggregates;
    const arg = (name: string) => field.args.find((a) => a.name === name)!;

    expect(isNonNullType(arg('aggregates').type)).toBe(true);
    expect(String(arg('aggregates').type)).toBe('[AggregateInput!]!');
    expect(String(arg('groupBy').type)).toBe('[GroupByInput!]');
    expect(arg('groupBy').defaultValue).toEqual([]);
    expect(arg('format').defaultValue).toBe('OBJECTS');
    expect(arg('includeRowCount').defaultValue).toBe(true);
    expect(isNonNullType(field.type)).toBe(true);
    expect(isNamedType(field.type) ? field.type.name : field.type.ofType?.name).toBe(
      'AggregateResult',
    );
  });

  /**
   * Verification of the enums of getAggregates: formats and time grains.
   */
  test('AggregateFormat and TimeGrain values', () => {
    expect(
      assertEnumType(schema.getType('AggregateFormat'))
        .getValues()
        .map((value) => value.name),
    ).toEqual(['OBJECTS', 'ARRAYS', 'LONG']);
    expect(
      assertEnumType(schema.getType('TimeGrain'))
        .getValues()
        .map((value) => value.name),
    ).toEqual(['SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']);
    // DataFormat de getFactTableWithMetadata reste sans LONG
    expect(
      assertEnumType(schema.getType('DataFormat'))
        .getValues()
        .map((value) => value.name),
    ).toEqual(['OBJECTS', 'ARRAYS']);
  });
});
