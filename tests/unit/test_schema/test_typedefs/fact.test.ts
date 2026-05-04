/**
 * Tests for the fact GraphQL type definitions.
 *
 * Validates the DataFormat enum, all fact-related object types
 * (DimensionDetail, Fact, PaginatedFacts, DatasetMetadata, DatasetWithMetadata,
 * AggregationStatistics, AggregatedFactsMetadata, AggregatedFactsWithMetadata),
 * and the fact query fields with their argument signatures.
 */

import { schema } from '../../../../src/schema/index.js';
import {
  assertObjectType,
  assertEnumType,
  isNonNullType,
  isNamedType,
  GraphQLFieldMap,
} from 'graphql';

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
   * Verification that DimensionDetail has non-null name, value, and label.
   */
  test('DimensionDetail has non-null name, value, label', () => {
    // Extraction des champs du type DimensionDetail
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('DimensionDetail')
    ).getFields();

    // Caractère non-null de chaque champ descriptif
    for (const f of ['name', 'value', 'label']) {
      expect(fields).toHaveProperty(f);
      expect(isNonNullType(fields[f].type)).toBe(true);
    }
  });

  /**
   * Verification that Fact exposes value and dimensionDetails.
   */
  test('Fact has value and dimensionDetails', () => {
    // Extraction des champs du type Fact
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('Fact')
    ).getFields();

    expect(fields).toHaveProperty('value');
    expect(fields).toHaveProperty('dimensionDetails');
  });

  /**
   * Verification that PaginatedFacts exposes all pagination fields.
   */
  test('PaginatedFacts has data, total, hasNextPage, currentPage, totalPages', () => {
    // Extraction des champs du type paginé
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('PaginatedFacts')
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
      schema.getType('DatasetMetadata')
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
      schema.getType('DatasetWithMetadata')
    ).getFields();

    // Présence des champs structurels du dataset
    for (const f of ['columns', 'data', 'metadata']) {
      expect(fields).toHaveProperty(f);
    }
  });

  /**
   * Verification that AggregationStatistics exposes mean, median, stdDev, and quartiles.
   */
  test('AggregationStatistics has mean, median, stdDev, quartiles', () => {
    // Extraction des champs du type statistiques
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('AggregationStatistics')
    ).getFields();

    // Présence des indicateurs statistiques attendus
    for (const f of ['mean', 'median', 'stdDev', 'quartiles']) {
      expect(fields).toHaveProperty(f);
    }
  });

  /**
   * Verification that AggregatedFactsMetadata has all analysis fields.
   */
  test('AggregatedFactsMetadata has count, keyExtent, valueExtent, statistics, groupByFieldInfo, generatedAt', () => {
    // Extraction des champs du type métadonnées d'agrégation
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('AggregatedFactsMetadata')
    ).getFields();

    // Présence des champs d'analyse d'agrégation
    for (const f of [
      'count',
      'keyExtent',
      'valueExtent',
      'statistics',
      'groupByFieldInfo',
      'generatedAt',
    ]) {
      expect(fields).toHaveProperty(f);
    }
  });

  /**
   * Verification that AggregatedFactsWithMetadata exposes data and metadata.
   */
  test('AggregatedFactsWithMetadata has data and metadata', () => {
    // Extraction des champs du type agrégation enrichie
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('AggregatedFactsWithMetadata')
    ).getFields();

    expect(fields).toHaveProperty('data');
    expect(fields).toHaveProperty('metadata');
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
   * Verification that getFactTable exists with all expected filter and pagination args.
   */
  test('getFactTable exists with limit, offset, structuredFilters, sort, database args', () => {
    expect(queryFields).toHaveProperty('getFactTable');

    // Présence de chaque argument de filtrage et pagination
    for (const arg of ['limit', 'offset', 'structuredFilters', 'sort', 'database']) {
      expect(queryFields.getFactTable.args.find((a) => a.name === arg)).toBeDefined();
    }
  });

  /**
   * Verification that getFactTableWithMetadata has a format arg defaulting to OBJECTS.
   */
  test('getFactTableWithMetadata exists and has format arg defaulting to OBJECTS', () => {
    expect(queryFields).toHaveProperty('getFactTableWithMetadata');

    // Recherche de l'argument de format de sortie
    const formatArg = queryFields.getFactTableWithMetadata.args.find(
      (a) => a.name === 'format'
    );
    expect(formatArg).toBeDefined();

    // Valeur par défaut du format de sérialisation
    expect(formatArg!.defaultValue).toBe('OBJECTS');
  });

  /**
   * Verification that getAggregatedFacts requires groupBy and accepts aggregation.
   */
  test('getAggregatedFacts exists with groupBy (NonNull) and aggregation args', () => {
    expect(queryFields).toHaveProperty('getAggregatedFacts');

    // Recherche de l'argument de regroupement obligatoire
    const groupByArg = queryFields.getAggregatedFacts.args.find(
      (a) => a.name === 'groupBy'
    );
    expect(groupByArg).toBeDefined();

    // Caractère obligatoire de l'argument groupBy
    expect(isNonNullType(groupByArg!.type)).toBe(true);
    expect(
      queryFields.getAggregatedFacts.args.find((a) => a.name === 'aggregation')
    ).toBeDefined();
  });

  /**
   * Verification that getAggregatedFactsWithMetadata returns the correct named type.
   */
  test('getAggregatedFactsWithMetadata returns AggregatedFactsWithMetadata', () => {
    expect(queryFields).toHaveProperty('getAggregatedFactsWithMetadata');

    // Résolution du type de retour (nommé ou enveloppé dans NonNull/List)
    const returnType = queryFields.getAggregatedFactsWithMetadata.type;
    expect(
      isNamedType(returnType) ? returnType.name : returnType.ofType?.name
    ).toBe('AggregatedFactsWithMetadata');
  });
});
