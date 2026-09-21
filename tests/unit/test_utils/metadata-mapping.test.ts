/**
 * Unit tests for the metadata mapping module (src/utils/metadata-mapping.ts).
 *
 * This module is the single translation point between the snake_case columns
 * of the `metadata` table and the camelCase GraphQL contract, so it owns the
 * explicit column projection, the boolean coercion DuckDB requires, and the
 * normalisation of every nullable UI field.
 */

import {
  METADATA_COLUMNS,
  METADATA_SELECT,
  toFieldMetadata,
} from '../../../src/utils/metadata-mapping.js';

// ─── Projection ───────────────────────────────────────────────────────────────

describe('METADATA_COLUMNS / METADATA_SELECT', () => {
  test('déclare exactement les onze colonnes de la spec §2.2', () => {
    expect([...METADATA_COLUMNS]).toEqual([
      'name',
      'label',
      'sql_type',
      'is_primary_key',
      'is_categorical',
      'parent_name',
      'unit',
      'display_format',
      'family',
      'description',
      'default_aggregation',
    ]);
  });

  test('la projection SQL nomme chaque colonne au lieu de SELECT *', () => {
    expect(METADATA_SELECT).not.toContain('*');
    for (const column of METADATA_COLUMNS) {
      expect(METADATA_SELECT).toContain(column);
    }
  });
});

// ─── Conversion d'une ligne ───────────────────────────────────────────────────

describe('toFieldMetadata', () => {
  test('renomme les onze colonnes en camelCase', () => {
    const row = {
      name: 'value',
      label: 'Measurement Value',
      sql_type: 'DOUBLE',
      is_primary_key: false,
      is_categorical: false,
      parent_name: null,
      unit: '€',
      display_format: ',.2f',
      family: 'Économie',
      description: "Valeur mesurée de l'indicateur",
      default_aggregation: 'SUM',
    };

    expect(toFieldMetadata(row)).toEqual({
      name: 'value',
      label: 'Measurement Value',
      sqlType: 'DOUBLE',
      isPrimaryKey: false,
      isCategorical: false,
      parentName: null,
      unit: '€',
      displayFormat: ',.2f',
      family: 'Économie',
      description: "Valeur mesurée de l'indicateur",
      defaultAggregation: 'SUM',
    });
  });

  test('convertit en booléen les indicateurs stockés en entier', () => {
    // DuckDB renvoie les BOOLEAN en entiers à travers l'accesseur JSON
    const result = toFieldMetadata({
      name: 'country',
      label: 'Country',
      sql_type: 'VARCHAR',
      is_primary_key: 1,
      is_categorical: 1,
    });

    expect(result.isPrimaryKey).toBe(true);
    expect(result.isCategorical).toBe(true);
    expect(typeof result.isPrimaryKey).toBe('boolean');
    expect(typeof result.isCategorical).toBe('boolean');
  });

  test('normalise en null les six champs d’UI absents', () => {
    const result = toFieldMetadata({
      name: 'is_provisional',
      label: 'Provisional',
      sql_type: 'BOOLEAN',
      is_primary_key: 0,
      is_categorical: 0,
    });

    expect(result.parentName).toBeNull();
    expect(result.unit).toBeNull();
    expect(result.displayFormat).toBeNull();
    expect(result.family).toBeNull();
    expect(result.description).toBeNull();
    expect(result.defaultAggregation).toBeNull();
  });

  test('distingue null et undefined d’une chaîne vide', () => {
    const result = toFieldMetadata({
      name: 'notes',
      label: 'Notes',
      sql_type: 'VARCHAR',
      is_primary_key: 0,
      is_categorical: 0,
      unit: '',
      description: null,
    });

    // Une chaîne vide déclarée par le producteur reste une chaîne vide
    expect(result.unit).toBe('');
    expect(result.description).toBeNull();
  });

  test('replie le libellé sur le nom technique quand il est absent', () => {
    // `label` est NOT NULL en base, mais un catalogue bricolé peut l'omettre
    const result = toFieldMetadata({
      name: 'horizon',
      sql_type: 'INTEGER',
      is_primary_key: 1,
      is_categorical: 0,
    });

    expect(result.label).toBe('horizon');
  });
});
