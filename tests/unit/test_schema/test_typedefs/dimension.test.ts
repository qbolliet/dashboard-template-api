/**
 * Tests for the dimension GraphQL type definitions.
 *
 * Validates the Dimension object type and the getDimensionTable query field
 * with its expected arguments.
 */

import { schema } from '../../../../src/schema/index.js';
import { assertObjectType, GraphQLFieldMap } from 'graphql';

// ─── Types objet — dimension ──────────────────────────────────────────────────

describe('Object types — dimension', () => {
  /**
   * Verification that Dimension exposes value and label fields.
   */
  test('Dimension has value and label fields', () => {
    // Extraction des champs du type Dimension
    const fields: GraphQLFieldMap<unknown, unknown> = assertObjectType(
      schema.getType('Dimension')
    ).getFields();

    // Présence des champs d'affichage attendus
    expect(fields).toHaveProperty('value');
    expect(fields).toHaveProperty('label');
  });
});

// ─── Champs de la Query — dimension ──────────────────────────────────────────

describe('Query fields — dimension', () => {
  // Référence aux champs de la Query, initialisée avant tous les tests
  let queryFields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(() => {
    queryFields = schema.getQueryType()!.getFields();
  });

  /**
   * Verification that getDimensionTable exists with name and optional database arguments.
   */
  test('getDimensionTable exists with name and optional database args', () => {
    expect(queryFields).toHaveProperty('getDimensionTable');

    // Présence des arguments de sélection de la table de dimension
    expect(
      queryFields.getDimensionTable.args.find((a) => a.name === 'name')
    ).toBeDefined();
    expect(
      queryFields.getDimensionTable.args.find((a) => a.name === 'database')
    ).toBeDefined();
  });
});
