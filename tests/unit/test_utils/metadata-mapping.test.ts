/**
 * Unit tests for the metadata mapping module (src/utils/metadata-mapping.ts).
 *
 * This module is the single translation point between the snake_case columns
 * of the `metadata` table and the camelCase GraphQL contract, so it owns the
 * explicit column projection, the boolean coercion DuckDB requires, and the
 * normalisation of every nullable UI field. It also derives `labelFields`
 * (inverse of `labelFor`) and holds the single rule choosing the label column
 * of a code column (resolveLabelField, revue §5.8), and exposes the type
 * family and filter operations of a column, cross-checked against treeToSQL.
 */

import { GraphQLError } from 'graphql';

import {
  METADATA_COLUMNS,
  METADATA_SELECT,
  METADATA_FIELD_WITH_LABELS_WHERE,
  TYPE_FAMILIES,
  filterOperationsOf,
  indexMetadataByName,
  resolveLabelField,
  sortByColumnPosition,
  toFieldMetadata,
  toFieldMetadataWithLabels,
  typeFamilyOf,
  withLabelFields,
} from '../../../src/utils/metadata-mapping.js';
import { FILTER_OPERATIONS, treeToSQL } from '../../../src/utils/filter-tree.js';
import type { FilterOperation } from '../../../src/utils/filter-tree.js';
import type { FieldMetadata, TypeFamily } from '../../../src/utils/metadata-mapping.js';

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
      /not a label column of "year"\. Available: none/,
    );
  });

  test('labelField désignant la colonne de code elle-même → BAD_USER_INPUT', () => {
    expect(() => resolveLabelField('nc8', byName, 'nc8')).toThrow(GraphQLError);
  });
});

// ─── Ordre physique des colonnes ──────────────────────────────────────────────

describe('sortByColumnPosition', () => {
  /** A metadata row carrying only its name. */
  const row = (name: string): FieldMetadata => toFieldMetadata({ name, sql_type: 'VARCHAR' });
  const names = (fields: readonly FieldMetadata[]): string[] => fields.map((f) => f.name);

  test('ordonne les lignes selon la position de leur colonne dans fact_table', () => {
    // La base écrit metadata par ordre alphabétique, non par ordre des colonnes
    const alphabetical = [row('amount'), row('label'), row('observed_on'), row('quantity')];
    const positions = new Map([
      ['label', 1],
      ['observed_on', 2],
      ['amount', 3],
      ['quantity', 4],
    ]);

    const { fields, unplaced } = sortByColumnPosition(alphabetical, positions);

    expect(names(fields)).toEqual(['label', 'observed_on', 'amount', 'quantity']);
    expect(unplaced).toEqual([]);
  });

  test('ne dépend que de l’ordre des positions, pas de leur valeur', () => {
    const positions = new Map([
      ['b', 40],
      ['a', 90],
      ['c', 7],
    ]);

    expect(names(sortByColumnPosition([row('a'), row('b'), row('c')], positions).fields)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  test('place en fin de liste, par nom, une ligne dont la colonne est absente, et la signale', () => {
    const positions = new Map([
      ['country', 1],
      ['value', 2],
    ]);

    const { fields, unplaced } = sortByColumnPosition(
      [row('zeta'), row('value'), row('alpha'), row('country')],
      positions,
    );

    expect(names(fields)).toEqual(['country', 'value', 'alpha', 'zeta']);
    expect(unplaced).toEqual(['alpha', 'zeta']);
  });

  test('sans aucune position (fact_table illisible), tout est en fin de liste, par nom', () => {
    const { fields, unplaced } = sortByColumnPosition([row('b'), row('a')], new Map());

    expect(names(fields)).toEqual(['a', 'b']);
    expect(unplaced).toEqual(['a', 'b']);
  });

  test('ne modifie pas la liste reçue', () => {
    const input = [row('b'), row('a')];
    sortByColumnPosition(
      input,
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );

    expect(names(input)).toEqual(['b', 'a']);
  });

  test('une liste vide reste vide', () => {
    expect(sortByColumnPosition([], new Map([['a', 1]]))).toEqual({ fields: [], unplaced: [] });
  });
});

// ─── Famille de type et opérations de filtre ──────────────────────────────────

describe('typeFamilyOf', () => {
  test.each<[string, TypeFamily]>([
    // Entiers signés et non signés
    ['TINYINT', 'INTEGER'],
    ['SMALLINT', 'INTEGER'],
    ['INTEGER', 'INTEGER'],
    ['BIGINT', 'INTEGER'],
    ['HUGEINT', 'INTEGER'],
    ['UTINYINT', 'INTEGER'],
    ['USMALLINT', 'INTEGER'],
    ['UINTEGER', 'INTEGER'],
    ['UBIGINT', 'INTEGER'],
    ['UHUGEINT', 'INTEGER'],
    // Flottants et décimaux
    ['FLOAT', 'NUMBER'],
    ['DOUBLE', 'NUMBER'],
    ['DECIMAL', 'NUMBER'],
    ['DECIMAL(18)', 'NUMBER'],
    ['DECIMAL(10,2)', 'NUMBER'],
    ['DECIMAL(38,9)', 'NUMBER'],
    // Date et dates-heures
    ['DATE', 'DATE'],
    ['TIMESTAMP', 'TIMESTAMP'],
    ['TIMESTAMP_S', 'TIMESTAMP'],
    ['TIMESTAMP_MS', 'TIMESTAMP'],
    ['TIMESTAMP_NS', 'TIMESTAMP'],
    ['TIMESTAMP WITH TIME ZONE', 'TIMESTAMP'],
    ['TIMESTAMPTZ', 'TIMESTAMP'],
    ['VARCHAR', 'TEXT'],
    ['BOOLEAN', 'BOOLEAN'],
    // Normalisation : casse et espaces ignorés, comme pour la validation des filtres
    [' double ', 'NUMBER'],
    ['ubigint', 'INTEGER'],
    ['decimal( 10 , 2 )', 'NUMBER'],
    ['date', 'DATE'],
    ['timestamp  with   time zone', 'TIMESTAMP'],
    // Tout le reste
    ['TIME', 'OTHER'],
    ['INTERVAL', 'OTHER'],
    ['BLOB', 'OTHER'],
    ['UUID', 'OTHER'],
    ['INTEGER[]', 'OTHER'],
    ['DECIMAL(40,2)', 'OTHER'],
    ['', 'OTHER'],
  ])('%j → %s', (sqlType, family) => {
    expect(typeFamilyOf(sqlType)).toBe(family);
  });

  test('une valeur non textuelle est OTHER, sans exception', () => {
    expect(typeFamilyOf(undefined as unknown as string)).toBe('OTHER');
    expect(typeFamilyOf(null as unknown as string)).toBe('OTHER');
  });

  test('ne renvoie que des valeurs de TYPE_FAMILIES', () => {
    for (const sqlType of [
      'UBIGINT',
      'DOUBLE',
      'DATE',
      'TIMESTAMP',
      'VARCHAR',
      'BOOLEAN',
      'TIME',
    ]) {
      expect(TYPE_FAMILIES).toContain(typeFamilyOf(sqlType));
    }
  });
});

describe('filterOperationsOf', () => {
  test('numérique (entier ou non) : comparaisons, intervalle, appartenance, présence', () => {
    const numeric = [
      'EQ',
      'NEQ',
      'GT',
      'GTE',
      'LT',
      'LTE',
      'BETWEEN',
      'NOT_BETWEEN',
      'IN',
      'NOT_IN',
      'IS_NULL',
      'IS_NOT_NULL',
    ];
    expect(filterOperationsOf('UBIGINT')).toEqual(numeric);
    expect(filterOperationsOf('DOUBLE')).toEqual(numeric);
    expect(filterOperationsOf('DECIMAL(10,2)')).toEqual(numeric);
  });

  test('date et date-heure partagent les opérations temporelles', () => {
    expect(filterOperationsOf('DATE')).toEqual(filterOperationsOf('TIMESTAMPTZ'));
    expect(filterOperationsOf('DATE')).toEqual(
      expect.arrayContaining(['BEFORE', 'AFTER', 'ON_OR_BEFORE', 'ON_OR_AFTER', 'BETWEEN']),
    );
    expect(filterOperationsOf('DATE')).not.toContain('GT');
  });

  test('texte : familles LIKE / ILIKE et MATCHES, pas de comparaison d’ordre', () => {
    const ops = filterOperationsOf('VARCHAR');
    expect(ops).toEqual(expect.arrayContaining(['CONTAINS', 'ICONTAINS', 'IEQ', 'MATCHES', 'IN']));
    expect(ops).not.toContain('GT');
    expect(ops).not.toContain('BETWEEN');
  });

  test('booléen : égalité, raccourcis IS_TRUE…, présence', () => {
    expect(filterOperationsOf('BOOLEAN')).toEqual([
      'EQ',
      'NEQ',
      'IS_TRUE',
      'IS_FALSE',
      'IS_NOT_TRUE',
      'IS_NOT_FALSE',
      'IS_NULL',
      'IS_NOT_NULL',
    ]);
  });

  test.each(['TIME', 'INTERVAL', 'BLOB', '', 'DECIMAL(40,2)'])(
    'OTHER (%j) : IS_NULL et IS_NOT_NULL seulement',
    (sqlType) => {
      expect(filterOperationsOf(sqlType)).toEqual(['IS_NULL', 'IS_NOT_NULL']);
    },
  );

  test('renvoie une copie : la modifier ne touche pas la règle du serveur', () => {
    const ops = filterOperationsOf('BOOLEAN');
    ops.push('GT');
    expect(filterOperationsOf('BOOLEAN')).not.toContain('GT');
  });
});

// ─── Test croisé : filterOperations = ce que treeToSQL accepte ────────────────

describe('filterOperationsOf ↔ treeToSQL', () => {
  // Opérations sans valeur (IS NULL, IS TRUE…)
  const VALUELESS = new Set<FilterOperation>([
    'IS_NULL',
    'IS_NOT_NULL',
    'IS_TRUE',
    'IS_FALSE',
    'IS_NOT_TRUE',
    'IS_NOT_FALSE',
  ]);

  // Valeur scalaire valide pour chaque famille
  const SCALAR: Record<TypeFamily, unknown> = {
    INTEGER: 7,
    NUMBER: 1.5,
    DATE: '2024-01-01',
    TIMESTAMP: '2024-01-01T08:00:00',
    TEXT: 'abc',
    BOOLEAN: true,
    OTHER: '08:00:00',
  };

  /**
   * Builds a value the operation accepts on a column of the given family.
   *
   * @param operation - Filter operation.
   * @param family - Type family of the column.
   * @returns The criterion value, undefined for a value-less operation.
   */
  // Valeur d'exemple adaptée à l'opération et à la famille
  const sampleValue = (operation: FilterOperation, family: TypeFamily): unknown => {
    if (VALUELESS.has(operation)) return undefined;
    const scalar = SCALAR[family];
    if (operation === 'BETWEEN' || operation === 'NOT_BETWEEN') return { min: scalar, max: scalar };
    if (operation === 'IN' || operation === 'NOT_IN') return [scalar];
    return scalar;
  };

  /**
   * Compiles a one-criterion tree on a column `c` of the given SQL type.
   *
   * @param sqlType - SQL type of the column.
   * @param operation - Filter operation.
   * @returns The compiled filter.
   */
  // Compilation d'un critère unique sur une colonne du type donné
  const compile = (sqlType: string, operation: FilterOperation) =>
    treeToSQL(
      {
        children: [
          {
            criterion: {
              variable: 'c',
              operation,
              ...(VALUELESS.has(operation)
                ? {}
                : { value: sampleValue(operation, typeFamilyOf(sqlType)) }),
            },
          },
        ],
      },
      new Map([['c', { sqlType }]]),
    );

  const TYPES = [
    'UBIGINT',
    'TINYINT',
    'DOUBLE',
    'DECIMAL(10,2)',
    'DECIMAL',
    'DATE',
    'TIMESTAMP',
    'TIMESTAMPTZ',
    'VARCHAR',
    'BOOLEAN',
    'TIME',
    'BLOB',
  ];
  const cases = TYPES.flatMap((sqlType) =>
    FILTER_OPERATIONS.map((operation) => [sqlType, operation] as [string, FilterOperation]),
  );

  test.each(cases)('%s × %s', (sqlType, operation) => {
    if (filterOperationsOf(sqlType).includes(operation)) {
      // Opération listée : acceptée par le compilateur
      expect(() => compile(sqlType, operation)).not.toThrow();
    } else {
      // Opération absente : refusée pour l'opération, jamais pour la valeur
      let caught: unknown;
      try {
        compile(sqlType, operation);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GraphQLError);
      expect((caught as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
      expect((caught as GraphQLError).message).toMatch(
        /is not allowed on column|only IS_NULL and IS_NOT_NULL are allowed/,
      );
    }
  });
});
