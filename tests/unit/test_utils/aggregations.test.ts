/**
 * Unit tests for the aggregation rules (src/utils/aggregations.ts).
 *
 * The aggregation allowed on a measure depends on the type family of its SQL
 * type: SUM, AVG and MEDIAN require a numeric measure, MIN and MAX a numeric
 * or temporal one, MODE and COUNT apply to every type. The family of the
 * aggregated value drives its extent and statistics.
 */

import {
  AGGREGATIONS,
  aggregatedValueFamily,
  allowedAggregations,
  measureFamily,
} from '../../../src/utils/aggregations.js';

// ─── Agrégations admises ──────────────────────────────────────────────────────

describe('allowedAggregations', () => {
  test.each([
    ['DOUBLE', ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE']],
    ['BIGINT', ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE']],
    ['DECIMAL(10,2)', ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE']],
    ['DATE', ['MAX', 'MIN', 'COUNT', 'MODE']],
    ['TIMESTAMP', ['MAX', 'MIN', 'COUNT', 'MODE']],
    ['VARCHAR', ['COUNT', 'MODE']],
    ['BOOLEAN', ['COUNT', 'MODE']],
    ['INTEGER[]', ['COUNT', 'MODE']],
    ['', ['COUNT', 'MODE']],
  ])('%s → %j', (sqlType, expected) => {
    expect(allowedAggregations(sqlType)).toEqual(expected);
  });

  test('an unknown type (null metadata) only allows COUNT and MODE', () => {
    expect(allowedAggregations(null)).toEqual(['COUNT', 'MODE']);
    expect(allowedAggregations(undefined)).toEqual(['COUNT', 'MODE']);
  });

  test('COUNT and MODE are allowed on every type', () => {
    for (const sqlType of ['DOUBLE', 'DATE', 'VARCHAR', 'BOOLEAN', 'BLOB']) {
      expect(allowedAggregations(sqlType)).toEqual(expect.arrayContaining(['COUNT', 'MODE']));
    }
  });

  test('AGGREGATIONS lists the seven values of the enum', () => {
    expect([...AGGREGATIONS].sort()).toEqual(
      ['AVG', 'COUNT', 'MAX', 'MEDIAN', 'MIN', 'MODE', 'SUM'].sort(),
    );
  });
});

// ─── Famille de la valeur agrégée ─────────────────────────────────────────────

describe('aggregatedValueFamily', () => {
  test.each([
    ['SUM', 'BIGINT', 'numeric'],
    ['AVG', 'DOUBLE', 'numeric'],
    ['MEDIAN', 'FLOAT', 'numeric'],
    ['COUNT', 'VARCHAR', 'numeric'],
    ['COUNT', 'DATE', 'numeric'],
    ['MAX', 'DATE', 'date'],
    ['MIN', 'DOUBLE', 'numeric'],
    ['MODE', 'VARCHAR', 'text'],
    ['MODE', 'BOOLEAN', 'boolean'],
    ['MODE', 'BLOB', 'other'],
    ['MODE', 'TIME', 'other'],
  ] as const)('%s on %s → %s', (aggregation, sqlType, expected) => {
    expect(aggregatedValueFamily(aggregation, sqlType)).toBe(expected);
  });
});

describe('measureFamily', () => {
  test('returns `other` instead of throwing for a type without family', () => {
    expect(measureFamily('BLOB')).toBe('other');
    expect(measureFamily(null)).toBe('other');
    expect(measureFamily('DATE')).toBe('date');
  });

  test('a bare DECIMAL, as the database declares it, is numeric', () => {
    expect(measureFamily('DECIMAL')).toBe('numeric');
    expect(allowedAggregations('DECIMAL')).toEqual(AGGREGATIONS);
  });
});
