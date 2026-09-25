/**
 * Unit tests for the metadata mapping module (src/utils/metadata-mapping.ts).
 *
 * This module is the single translation point between the snake_case columns
 * of the `metadata` table and the camelCase GraphQL contract, so it owns the
 * explicit column projection, the boolean coercion DuckDB requires, and the
 * normalisation of every nullable UI field. It also derives `labelFields`
 * (inverse of `labelFor`) and holds the single rule choosing the label column
 * of a code column (resolveLabelField, revue §5.8).
 */

import { GraphQLError } from 'graphql';

import {
  METADATA_COLUMNS,
  METADATA_SELECT,
  METADATA_FIELD_WITH_LABELS_WHERE,
  indexMetadataByName,
  resolveLabelField,
  toFieldMetadata,
  toFieldMetadataWithLabels,
  withLabelFields,
} from '../../../src/utils/metadata-mapping.js';
import type { FieldMetadata } from '../../../src/utils/metadata-mapping.js';

// ─── Projection ───────────────────────────────────────────────────────────────

describe('METADATA_COLUMNS / METADATA_SELECT', () => {
  test('déclare exactement les douze colonnes de la spec §2.2', () => {
    expect([...METADATA_COLUMNS]).toEqual([
      'name',
      'label',
      'sql_type',
      'is_primary_key',
      'is_categorical',
      'parent_name',
      'label_for',
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
  test('renomme les douze colonnes en camelCase, labelFields vide', () => {
    const row = {
      name: 'value',
      label: 'Measurement Value',
      sql_type: 'DOUBLE',
      is_primary_key: false,
      is_categorical: false,
      parent_name: null,
      label_for: null,
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
      labelFor: null,
      labelFields: [],
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

  test('normalise en null les sept champs d’UI absents', () => {
    const result = toFieldMetadata({
      name: 'is_provisional',
      label: 'Provisional',
      sql_type: 'BOOLEAN',
      is_primary_key: 0,
      is_categorical: 0,
    });

    expect(result.parentName).toBeNull();
    expect(result.labelFor).toBeNull();
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

// ─── Colonnes de libellés ─────────────────────────────────────────────────────

/**
 * Builds a metadata row in camelCase for the label column tests.
 *
 * @param name - Column name.
 * @param labelFor - Code column this label column renders, or null.
 * @returns A FieldMetadata row with empty labelFields.
 */
// Ligne de métadonnées minimale pour les tests de libellés
const field = (name: string, labelFor: string | null = null): FieldMetadata =>
  toFieldMetadata({
    name,
    label: name,
    sql_type: 'VARCHAR',
    is_primary_key: 0,
    is_categorical: 1,
    label_for: labelFor,
  });

// Schéma type : nc8 a deux libellés, nc6 un seul, year aucun
const TRADE_FIELDS = [
  field('nc6'),
  field('nc6_libelle', 'nc6'),
  field('nc8'),
  field('nc8_libelle_fr', 'nc8'),
  field('nc8_libelle_en', 'nc8'),
  field('year'),
];

describe('withLabelFields', () => {
  const byName = indexMetadataByName(withLabelFields(TRADE_FIELDS));

  test('calcule l’inverse de labelFor, trié par nom', () => {
    expect(byName.get('nc8')!.labelFields).toEqual(['nc8_libelle_en', 'nc8_libelle_fr']);
    expect(byName.get('nc6')!.labelFields).toEqual(['nc6_libelle']);
  });

  test('laisse labelFields vide sur une colonne sans libellés', () => {
    expect(byName.get('year')!.labelFields).toEqual([]);
  });

  test('laisse labelFields vide sur une colonne de libellés, qui garde son labelFor', () => {
    expect(byName.get('nc8_libelle_fr')!.labelFields).toEqual([]);
    expect(byName.get('nc8_libelle_fr')!.labelFor).toBe('nc8');
  });

  test('ne modifie pas les lignes reçues', () => {
    withLabelFields(TRADE_FIELDS);
    expect(TRADE_FIELDS.every((row) => row.labelFields.length === 0)).toBe(true);
  });
});

describe('toFieldMetadataWithLabels', () => {
  test('rend la colonne cherchée avec ses libellés, lus dans la même réponse', () => {
    const rows = [
      { name: 'nc8_libelle_fr', label_for: 'nc8' },
      { name: 'nc8', label_for: null },
    ];
    const result = toFieldMetadataWithLabels(rows, 'nc8');
    expect(result!.name).toBe('nc8');
    expect(result!.labelFields).toEqual(['nc8_libelle_fr']);
  });

  test('rend null quand la colonne est absente', () => {
    expect(toFieldMetadataWithLabels([], 'nc8')).toBeNull();
  });

  test('le filtre SQL lit la colonne et celles qui pointent vers elle', () => {
    expect(METADATA_FIELD_WITH_LABELS_WHERE).toBe('name = ? OR label_for = ?');
  });
});

// Table de vérité de la règle de choix (revue §5.8)
describe('resolveLabelField', () => {
  const byName = indexMetadataByName(withLabelFields(TRADE_FIELDS));

  test.each<[string, string | null | undefined, string | null]>([
    // labelField fourni et valide
    ['nc8', 'nc8_libelle_fr', 'nc8_libelle_fr'],
    ['nc8', 'nc8_libelle_en', 'nc8_libelle_en'],
    ['nc6', 'nc6_libelle', 'nc6_libelle'],
    // absent : seule colonne de libellés
    ['nc6', undefined, 'nc6_libelle'],
    ['nc6', null, 'nc6_libelle'],
    // absent : première par ordre alphabétique
    ['nc8', undefined, 'nc8_libelle_en'],
    ['nc8', '', 'nc8_libelle_en'],
    // aucune colonne de libellés
    ['year', undefined, null],
    ['unknown', undefined, null],
  ])('%s, labelField %p → %p', (fieldName, requested, expected) => {
    expect(resolveLabelField(fieldName, byName, requested)).toBe(expected);
  });

  test('labelField d’une autre colonne → BAD_USER_INPUT nommant les colonnes possibles', () => {
    let error: unknown;
    try {
      resolveLabelField('nc8', byName, 'nc6_libelle');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
    expect((error as GraphQLError).message).toContain('nc8_libelle_en, nc8_libelle_fr');
  });

  test('labelField sur une colonne sans libellés → BAD_USER_INPUT', () => {
    expect(() => resolveLabelField('year', byName, 'nc8_libelle_fr')).toThrow(
      /not a label column of 'year'\. Available: none/,
    );
  });

  test('labelField désignant la colonne de code elle-même → BAD_USER_INPUT', () => {
    expect(() => resolveLabelField('nc8', byName, 'nc8')).toThrow(GraphQLError);
  });
});
