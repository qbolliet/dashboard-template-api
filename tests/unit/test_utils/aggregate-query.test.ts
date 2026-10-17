/**
 * Unit tests for the aggregate query constructor (src/utils/aggregate-query.ts).
 *
 * resolveAggregateParams is the single gate of getAggregates: columns checked
 * against the metadata, grains on temporal columns only, effective aggregation
 * per aggregate (argument, defaultAggregation, SUM for a numeric measure),
 * type families, aliases, unique output names, bounds and sort. The resolved
 * parameters then go to buildAggregateQuery, the single producer of aggregate
 * SQL, checked here as text and bound values, with no database.
 */

import { GraphQLError } from 'graphql';
import {
  aggregateDisplayFormat,
  aggregateUnit,
  buildAggregateQuery,
  buildGroupCountQuery,
  longColumns,
  meltRows,
  resolveAggregateParams,
  buildAggregateSelect,
  assertNumericAggregate,
} from '../../../src/utils/aggregate-query.js';
import type { FieldMetadata } from '../../../src/utils/metadata-mapping.js';
import type {
  AggregatePageParams,
  AggregateRequest,
  ResolvedAggregateParams,
} from '../../../src/utils/aggregate-query.js';

// ─── Métadonnées de test ──────────────────────────────────────────────────────

/**
 * Builds a metadata row.
 *
 * @param name - Column name.
 * @param sqlType - DuckDB type.
 * @param extra - Fields overriding the defaults.
 * @returns The metadata row.
 */
// Ligne de métadonnées minimale
const meta = (
  name: string,
  sqlType: string,
  extra: Partial<FieldMetadata> = {},
): FieldMetadata => ({
  name,
  label: name,
  sqlType,
  isPrimaryKey: false,
  isCategorical: false,
  parentName: null,
  labelFor: null,
  labelFields: [],
  unit: null,
  displayFormat: null,
  family: null,
  description: null,
  defaultAggregation: null,
  ...extra,
});

const METADATA = new Map<string, FieldMetadata>(
  [
    meta('country', 'VARCHAR', { isCategorical: true }),
    meta('nc8', 'VARCHAR', { labelFields: ['nc8_libelle_en', 'nc8_libelle_fr'] }),
    meta('date', 'DATE'),
    meta('ingested_at', 'TIMESTAMP'),
    meta('event_at', 'TIMESTAMP WITH TIME ZONE'),
    meta('value', 'DOUBLE', { unit: '€', displayFormat: ',.2f', defaultAggregation: 'SUM' }),
    meta('lower_bound', 'FLOAT', { defaultAggregation: 'MIN' }),
    meta('headcount', 'BIGINT', { displayFormat: ',d' }),
    meta('horizon', 'INTEGER'),
    meta('notes', 'VARCHAR'),
    meta('is_provisional', 'BOOLEAN'),
    meta('taux chômage', 'DOUBLE'),
  ].map((field) => [field.name, field]),
);

/**
 * Resolves a request against the test metadata.
 *
 * @param request - Request, aggregates defaulting to SUM of value.
 * @returns The resolved parameters.
 */
// Résolution d'une requête contre les métadonnées de test
const resolve = (request: Partial<AggregateRequest>): ResolvedAggregateParams =>
  resolveAggregateParams(
    { aggregates: [{ measure: 'value', aggregation: 'SUM' }], ...request },
    METADATA,
  );

/**
 * Asserts that a request is rejected as BAD_USER_INPUT.
 *
 * @param request - Request to resolve.
 * @param fragment - Substring expected in the message.
 */
// Rejet BAD_USER_INPUT attendu
const expectRejected = (request: Partial<AggregateRequest>, fragment: string): void => {
  let error: unknown;
  try {
    resolve(request);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GraphQLError);
  expect((error as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
  expect((error as GraphQLError).message).toContain(fragment);
};

/**
 * Page parameters around resolved parameters.
 *
 * @param resolved - Resolved parameters.
 * @param extra - Filter or page overrides.
 * @returns Page parameters.
 */
// Paramètres de page autour de paramètres résolus
const page = (
  resolved: ResolvedAggregateParams,
  extra: Partial<AggregatePageParams> = {},
): AggregatePageParams => ({ ...resolved, where: null, limit: 100, offset: 0, ...extra });

const TABLE = '"cat"."main"."fact_table"';

// ─── Résolution ───────────────────────────────────────────────────────────────

describe('resolveAggregateParams — agrégation effective', () => {
  test('argument, puis defaultAggregation, puis SUM numérique', () => {
    const { aggregates } = resolve({
      aggregates: [
        { measure: 'value', aggregation: 'AVG' },
        { measure: 'lower_bound' },
        { measure: 'horizon' },
      ],
    });

    expect(aggregates).toEqual([
      { measure: 'value', aggregation: 'AVG', alias: 'value_avg' },
      { measure: 'lower_bound', aggregation: 'MIN', alias: 'lower_bound_min' },
      { measure: 'horizon', aggregation: 'SUM', alias: 'horizon_sum' },
    ]);
  });

  test('mesure non numérique sans défaut → erreur, pas de COUNT implicite', () => {
    expectRejected({ aggregates: [{ measure: 'notes' }] }, 'declares no defaultAggregation');
  });

  test.each([
    ['notes', 'SUM', 'Allowed aggregations: COUNT, MODE'],
    ['date', 'AVG', 'Allowed aggregations: MAX, MIN, COUNT, MODE'],
    ['is_provisional', 'MIN', 'Allowed aggregations: COUNT, MODE'],
    ['ingested_at', 'MEDIAN', 'Allowed aggregations: MAX, MIN, COUNT, MODE'],
  ] as const)('%s en %s → refusé', (measure, aggregation, fragment) => {
    expectRejected({ aggregates: [{ measure, aggregation }] }, fragment);
  });

  test('MIN/MAX sur une date, MODE et COUNT sur tout type sont admis', () => {
    expect(() =>
      resolve({
        aggregates: [
          { measure: 'date', aggregation: 'MAX' },
          { measure: 'notes', aggregation: 'MODE' },
          { measure: 'is_provisional', aggregation: 'COUNT' },
        ],
      }),
    ).not.toThrow();
  });
});

describe('resolveAggregateParams — colonnes, alias et bornes', () => {
  test('colonnes inconnues → erreur nommant la colonne', () => {
    expectRejected({ groupBy: [{ field: 'nope' }] }, 'Unknown groupBy column(s): "nope"');
    expectRejected({ aggregates: [{ measure: 'nope' }] }, 'Unknown measure column(s): "nope"');
  });

  test('colonne de groupe en double → erreur', () => {
    expectRejected(
      { groupBy: [{ field: 'country' }, { field: 'country' }] },
      'groupBy holds "country" more than once',
    );
  });

  test('alias par défaut, alias explicite et motif', () => {
    const { aggregates } = resolve({
      aggregates: [
        { measure: 'value', aggregation: 'SUM', alias: 'total' },
        { measure: 'taux chômage', aggregation: 'AVG' },
      ],
    });
    expect(aggregates.map((aggregate) => aggregate.alias)).toEqual(['total', 'taux chômage_avg']);

    expectRejected({ aggregates: [{ measure: 'value', alias: 'Total' }] }, 'must match');
    expectRejected({ aggregates: [{ measure: 'value', alias: '1x' }] }, 'must match');
    expectRejected({ aggregates: [{ measure: 'value', alias: 'a b' }] }, 'must match');
  });

  test('noms de sortie en double → erreur', () => {
    // Deux fois le même agrégat : même alias par défaut
    expectRejected(
      { aggregates: [{ measure: 'value' }, { measure: 'value', aggregation: 'SUM' }] },
      'Output column "value_sum" is produced more than once',
    );
    // Alias égal à une colonne de groupe, à un libellé ou à row_count
    expectRejected(
      { groupBy: [{ field: 'country' }], aggregates: [{ measure: 'value', alias: 'country' }] },
      '"country"',
    );
    expectRejected(
      { groupBy: [{ field: 'nc8' }], aggregates: [{ measure: 'value', alias: 'nc8__label' }] },
      '"nc8__label"',
    );
    expectRejected({ aggregates: [{ measure: 'value', alias: 'row_count' }] }, '"row_count"');
  });

  test('row_count libre comme alias quand includeRowCount est faux', () => {
    const { aggregates } = resolve({
      includeRowCount: false,
      aggregates: [{ measure: 'value', alias: 'row_count' }],
    });
    expect(aggregates[0].alias).toBe('row_count');
  });

  test('format LONG : une colonne de groupe ne peut pas s’appeler measure ou value', () => {
    const withValueGroup = new Map(METADATA).set('value', meta('value', 'DOUBLE'));
    expect(() =>
      resolveAggregateParams(
        {
          groupBy: [{ field: 'value' }],
          aggregates: [{ measure: 'horizon' }],
          format: 'LONG',
        },
        withValueGroup,
      ),
    ).toThrow('The LONG format names its columns measure and value');
    // Un alias, lui, devient une valeur de la colonne measure : admis
    expect(() =>
      resolve({ aggregates: [{ measure: 'value', alias: 'value' }], format: 'LONG' }),
    ).not.toThrow();
  });

  test('bornes API.AGGREGATES et liste vide', () => {
    expectRejected({ aggregates: [] }, 'at least one aggregate');
    expectRejected(
      {
        aggregates: Array.from({ length: 21 }, (_, index) => ({
          measure: 'value',
          aggregation: 'SUM' as const,
          alias: `a${index}`,
        })),
      },
      'cannot hold more than 20 aggregates',
    );
    expectRejected(
      {
        groupBy: ['country', 'nc8', 'date', 'ingested_at', 'event_at'].map((field) => ({ field })),
      },
      'cannot hold more than 4 columns',
    );
  });
});

describe('resolveAggregateParams — grains temporels', () => {
  test('grain sur DATE, TIMESTAMP et TIMESTAMPTZ', () => {
    const { groups } = resolve({
      groupBy: [
        { field: 'date', grain: 'MONTH' },
        { field: 'ingested_at', grain: 'MINUTE' },
        { field: 'event_at', grain: 'HOUR' },
      ],
    });

    expect(groups).toEqual([
      { field: 'date', grain: 'MONTH', truncation: 'date', labelField: null },
      { field: 'ingested_at', grain: 'MINUTE', truncation: 'timestamp', labelField: null },
      { field: 'event_at', grain: 'HOUR', truncation: 'timestamptz', labelField: null },
    ]);
  });

  test('grain hors DATE/TIMESTAMP → erreur', () => {
    expectRejected(
      { groupBy: [{ field: 'country', grain: 'MONTH' }] },
      'grain applies to DATE and TIMESTAMP columns only',
    );
  });

  test('grain infra-journalier sur une DATE → erreur listant les grains admis', () => {
    expectRejected(
      { groupBy: [{ field: 'date', grain: 'HOUR' }] },
      'Allowed grains: DAY, WEEK, MONTH, QUARTER, YEAR',
    );
  });

  test('libellé résolu par la règle par défaut, jamais avec un grain', () => {
    const { groups } = resolve({ groupBy: [{ field: 'nc8' }, { field: 'country' }] });

    expect(groups.map((group) => group.labelField)).toEqual(['nc8_libelle_en', null]);
  });
});

describe('resolveAggregateParams — tri', () => {
  test('tri client puis départage par chaque colonne de groupe', () => {
    const { sort } = resolve({
      groupBy: [{ field: 'country' }, { field: 'date', grain: 'YEAR' }],
      sort: [
        { by: 'value_sum', order: 'DESC' },
        { by: 'date', order: 'DESC' },
      ],
    });

    expect(sort).toEqual([
      { by: 'value_sum', order: 'DESC' },
      { by: 'date', order: 'DESC' },
      { by: 'country', order: 'ASC' },
    ]);
  });

  test('tri sur une colonne de libellés ou row_count admis', () => {
    const { sort } = resolve({
      groupBy: [{ field: 'nc8' }],
      sort: [{ by: 'nc8__label' }, { by: 'row_count', order: 'DESC' }],
    });

    expect(sort[0]).toEqual({ by: 'nc8__label', order: 'ASC' });
    expect(sort[1]).toEqual({ by: 'row_count', order: 'DESC' });
  });

  test('colonne de tri inconnue → erreur listant les colonnes triables', () => {
    expectRejected(
      { groupBy: [{ field: 'country' }], sort: [{ by: 'value' }] },
      'Sortable columns: country, value_sum, row_count',
    );
  });
});

// ─── SQL ──────────────────────────────────────────────────────────────────────

describe('buildAggregateQuery', () => {
  test('exemple audit-api.md §4.2 : trois agrégats, une seule requête', () => {
    const resolved = resolve({
      groupBy: [{ field: 'country' }],
      aggregates: [
        { measure: 'value', aggregation: 'SUM' },
        { measure: 'value', aggregation: 'AVG' },
        { measure: 'lower_bound', aggregation: 'MAX' },
      ],
    });
    const { sql, values } = buildAggregateQuery(
      page(resolved, { where: { sql: '"kind" = ?', params: ['Actual'] }, limit: 10, offset: 20 }),
      TABLE,
    );

    expect(sql).toBe(
      'SELECT * FROM (SELECT "country" AS "country", SUM("value") AS "value_sum", ' +
        'AVG("value") AS "value_avg", MAX("lower_bound") AS "lower_bound_max", ' +
        'COUNT(*) AS "row_count" FROM "cat"."main"."fact_table" WHERE "kind" = ? ' +
        'GROUP BY "country") ORDER BY "country" ASC LIMIT 10 OFFSET 20',
    );
    expect(sql.match(/SELECT/g)).toHaveLength(2);
    expect(values).toEqual(['Actual']);
  });

  test('agrégat global : ni GROUP BY ni ORDER BY', () => {
    const { sql } = buildAggregateQuery(page(resolve({})), TABLE);

    expect(sql).toBe(
      'SELECT * FROM (SELECT SUM("value") AS "value_sum", COUNT(*) AS "row_count" ' +
        'FROM "cat"."main"."fact_table") LIMIT 100 OFFSET 0',
    );
  });

  test('libellé par ANY_VALUE, sans row_count si includeRowCount est faux', () => {
    const { sql } = buildAggregateQuery(
      page(resolve({ groupBy: [{ field: 'nc8' }], includeRowCount: false })),
      TABLE,
    );

    expect(sql).toContain('"nc8" AS "nc8", ANY_VALUE("nc8_libelle_en") AS "nc8__label"');
    expect(sql).not.toContain('row_count');
  });

  test('grains : CAST pour une DATE, UTC pour un TIMESTAMPTZ', () => {
    const { sql } = buildAggregateQuery(
      page(
        resolve({
          groupBy: [
            { field: 'date', grain: 'MONTH' },
            { field: 'ingested_at', grain: 'DAY' },
            { field: 'event_at', grain: 'HOUR' },
          ],
        }),
      ),
      TABLE,
    );

    const month = `CAST(date_trunc('month', "date") AS DATE)`;
    const day = `date_trunc('day', "ingested_at")`;
    const hour = `timezone('UTC', date_trunc('hour', timezone('UTC', "event_at")))`;
    expect(sql).toContain(`${month} AS "date", ${day} AS "ingested_at", ${hour} AS "event_at"`);
    // Le GROUP BY répète les expressions, l'ORDER BY extérieur vise les sorties
    expect(sql).toContain(`GROUP BY ${month}, ${day}, ${hour})`);
    expect(sql).toContain('ORDER BY "date" ASC, "ingested_at" ASC, "event_at" ASC');
  });

  test('identifiants quotés, guillemets doublés', () => {
    const { sql } = buildAggregateQuery(
      page(resolve({ aggregates: [{ measure: 'taux chômage', aggregation: 'AVG' }] })),
      TABLE,
    );

    expect(sql).toContain('AVG("taux chômage") AS "taux chômage_avg"');
  });

  test('bornes de pagination non entières → erreur avant toute interpolation', () => {
    expect(() => buildAggregateQuery(page(resolve({}), { limit: 1.5 }), TABLE)).toThrow(
      'Invalid limit',
    );
    expect(() => buildAggregateQuery(page(resolve({}), { offset: -1 }), TABLE)).toThrow(
      'Invalid offset',
    );
  });
});

describe('buildAggregateSelect', () => {
  test('le SELECT interne de buildAggregateQuery, sans tri ni pagination', () => {
    const resolved = resolve({ groupBy: [{ field: 'nc8' }] });
    const where = { sql: '"kind" = ?', params: ['Actual'] };
    const select = buildAggregateSelect({ ...resolved, where }, TABLE);
    const pageQuery = buildAggregateQuery(page(resolved, { where }), TABLE);

    expect(select.sql).toBe(
      'SELECT "nc8" AS "nc8", ANY_VALUE("nc8_libelle_en") AS "nc8__label", ' +
        'SUM("value") AS "value_sum", COUNT(*) AS "row_count" FROM "cat"."main"."fact_table" ' +
        'WHERE "kind" = ? GROUP BY "nc8"',
    );
    expect(pageQuery.sql).toBe(
      `SELECT * FROM (${select.sql}) ORDER BY "nc8" ASC LIMIT 100 OFFSET 0`,
    );
    expect(select.values).toEqual(['Actual']);
  });

  test('sans agrégat : colonnes de groupe seules (comptage des groupes)', () => {
    const resolved = resolve({ groupBy: [{ field: 'country' }], includeRowCount: false });
    const { sql } = buildAggregateSelect({ ...resolved, aggregates: [] }, TABLE);

    expect(sql).toBe(
      'SELECT "country" AS "country" FROM "cat"."main"."fact_table" GROUP BY "country"',
    );
  });
});

describe('assertNumericAggregate', () => {
  test.each([
    ['SUM', 'value'],
    ['COUNT', 'notes'],
    ['MAX', 'horizon'],
    ['MODE', 'value'],
  ] as const)('%s de %s : résultat numérique accepté', (aggregation, measure) => {
    expect(() => assertNumericAggregate(aggregation, METADATA.get(measure)!)).not.toThrow();
  });

  test.each([
    ['MAX', 'date'],
    ['MODE', 'notes'],
    ['MODE', 'is_provisional'],
  ] as const)('%s de %s : refusé, un écart exige un nombre', (aggregation, measure) => {
    expect(() => assertNumericAggregate(aggregation, METADATA.get(measure)!)).toThrow(
      /is not numeric/,
    );
  });
});

describe('buildGroupCountQuery', () => {
  test('même GROUP BY que la page, groupe NULL compris, filtre lié', () => {
    const { groups } = resolve({
      groupBy: [{ field: 'date', grain: 'YEAR' }, { field: 'country' }],
    });
    const { sql, values } = buildGroupCountQuery(
      { groups, where: { sql: '"value" > ?', params: [0] } },
      TABLE,
    );

    expect(sql).toBe(
      'SELECT COUNT(*) AS total FROM (SELECT 1 FROM "cat"."main"."fact_table" WHERE "value" > ? ' +
        `GROUP BY CAST(date_trunc('year', "date") AS DATE), "country")`,
    );
    expect(values).toEqual([0]);
  });
});

// ─── Mise en forme et description des colonnes ────────────────────────────────

describe('format LONG', () => {
  const columns = ['country', 'value_sum', 'value_avg', 'row_count'];
  const rows = [
    { country: 'France', value_sum: 10, value_avg: 2, row_count: 5 },
    { country: null, value_sum: null, value_avg: null, row_count: 1 },
  ];

  test('colonnes : identifiants, puis measure et value', () => {
    expect(longColumns(columns, ['value_sum', 'value_avg'])).toEqual([
      'country',
      'row_count',
      'measure',
      'value',
    ]);
  });

  test('une ligne par (groupe, agrégat), dans l’ordre des agrégats', () => {
    expect(meltRows(rows, columns, ['value_sum', 'value_avg'])).toEqual([
      { country: 'France', row_count: 5, measure: 'value_sum', value: 10 },
      { country: 'France', row_count: 5, measure: 'value_avg', value: 2 },
      { country: null, row_count: 1, measure: 'value_sum', value: null },
      { country: null, row_count: 1, measure: 'value_avg', value: null },
    ]);
  });
});

describe('unité et format d’un agrégat', () => {
  test.each([
    ['SUM', 'value', '€', ',.2f'],
    ['COUNT', 'value', null, ',d'],
    ['SUM', 'headcount', null, ',d'],
    ['AVG', 'headcount', null, ',.2f'],
    ['MEDIAN', 'headcount', null, ',.2f'],
    ['AVG', 'horizon', null, null],
  ] as const)('%s(%s) → unité %j, format %j', (aggregation, measure, unit, format) => {
    const field = METADATA.get(measure)!;
    expect(aggregateUnit(aggregation, field)).toBe(unit);
    expect(aggregateDisplayFormat(aggregation, field)).toBe(format);
  });
});
