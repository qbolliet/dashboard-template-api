/**
 * Tests of the export resume cursor (src/export/after-cursor.ts).
 *
 * Pure functions, no database: completion of the effective sort into a total
 * order, the NULL-safe keyset predicate, and the opaque token round trip. The
 * predicate is checked against DuckDB end to end by the integration suite.
 */

import { describe, test, expect } from '@jest/globals';
import {
  assertCursorOrder,
  buildAfterPredicate,
  buildOrderBy,
  completeTotalOrder,
  decodeCursor,
  encodeCursor,
} from '../../../src/export/after-cursor.js';
import { ExportHttpError } from '../../../src/export/export-params.js';
import { ALL_COLUMNS_SORT } from '../../../src/utils/default-sort.js';
import type { KeyColumn } from '../../../src/export/after-cursor.js';

// Colonnes d'une table de test, dans l'ordre de la table
const COLUMNS = ['region', 'commune', 'date', 'population'];

describe('completeTotalOrder', () => {
  test('ORDER BY ALL becomes every column of the table, whatever the projection', () => {
    expect(completeTotalOrder([ALL_COLUMNS_SORT], COLUMNS, [])).toEqual(
      COLUMNS.map((field) => ({ field, order: 'ASC' })),
    );
  });

  test('cluster_by is completed with the primary keys it does not name', () => {
    const order = completeTotalOrder([{ field: 'region', order: 'ASC' }], COLUMNS, [
      'region',
      'commune',
      'date',
    ]);
    expect(order.map((k) => k.field)).toEqual(['region', 'commune', 'date']);
  });

  test('without primary key, every other column breaks the ties', () => {
    const order = completeTotalOrder([{ field: 'population', order: 'DESC' }], COLUMNS, []);
    expect(order).toEqual([
      { field: 'population', order: 'DESC' },
      { field: 'region', order: 'ASC' },
      { field: 'commune', order: 'ASC' },
      { field: 'date', order: 'ASC' },
    ]);
  });

  test('an order already total is left as is', () => {
    const sort: KeyColumn[] = [
      { field: 'date', order: 'DESC' },
      { field: 'commune', order: 'ASC' },
    ];
    expect(completeTotalOrder(sort, COLUMNS, ['commune', 'date'])).toEqual(sort);
  });
});

describe('buildOrderBy', () => {
  test('quotes every column and puts NULLs last in both directions', () => {
    expect(
      buildOrderBy([
        { field: 'taux chômage', order: 'DESC' },
        { field: 'a"b', order: 'ASC' },
      ]),
    ).toBe('ORDER BY "taux chômage" DESC NULLS LAST, "a""b" ASC NULLS LAST');
  });
});

describe('buildAfterPredicate', () => {
  const order: KeyColumn[] = [
    { field: 'a', order: 'ASC' },
    { field: 'b', order: 'DESC' },
  ];

  test('expands the comparison column by column, NULL-safe', () => {
    expect(buildAfterPredicate(order, ['1', 'x'])).toEqual({
      sql: '(("a" > ? OR "a" IS NULL)) OR ("a" IS NOT DISTINCT FROM ? AND ("b" < ? OR "b" IS NULL))',
      params: ['1', '1', 'x'],
    });
  });

  test('nothing follows a NULL key value (NULLS LAST)', () => {
    // a NULL : seules les lignes où a IS NULL et b vient après
    expect(buildAfterPredicate(order, [null, 'x'])).toEqual({
      sql: '("a" IS NOT DISTINCT FROM ? AND ("b" < ? OR "b" IS NULL))',
      params: [null, 'x'],
    });
    expect(buildAfterPredicate(order, [null, null])).toEqual({ sql: 'FALSE', params: [] });
  });
});

describe('cursor token', () => {
  const order: KeyColumn[] = [
    { field: 'région', order: 'ASC' },
    { field: 'date', order: 'DESC' },
  ];

  test('round-trips as an ASCII, URL-safe token', () => {
    const token = encodeCursor(order, ['Île-de-France’', null]);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const cursor = decodeCursor(token);
    expect(cursor.values).toEqual(['Île-de-France’', null]);
    expect(() => assertCursorOrder(cursor, order)).not.toThrow();
  });

  test.each([
    ['not base64 JSON', 'not-a-cursor'],
    ['wrong shape', Buffer.from('{"s":[],"k":[]}').toString('base64url')],
    ['length mismatch', Buffer.from('{"s":[["a","ASC"]],"k":[]}').toString('base64url')],
    ['bad direction', Buffer.from('{"s":[["a","UP"]],"k":["1"]}').toString('base64url')],
    ['non-text value', Buffer.from('{"s":[["a","ASC"]],"k":[1]}').toString('base64url')],
  ])('400 for a token with %s', (_label, token) => {
    expect(() => decodeCursor(token)).toThrow(ExportHttpError);
  });

  test('400 when the cursor was issued for another order', () => {
    const cursor = decodeCursor(encodeCursor(order, ['a', 'b']));
    const reversed: KeyColumn[] = [
      { field: 'région', order: 'DESC' },
      { field: 'date', order: 'DESC' },
    ];
    expect(() => assertCursorOrder(cursor, reversed)).toThrow(/another sort or schema/);
  });
});
