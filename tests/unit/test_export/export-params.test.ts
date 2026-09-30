/**
 * Tests of the export parameter parsing (src/export/export-params.ts).
 *
 * Pure functions, no database: format whitelist, identifier validation of
 * fields/sort/catalog/schema, filters JSON shape, limit ceiling, unknown
 * parameters, and the coercion of the EXPORT configuration section.
 */

import { describe, test, expect } from '@jest/globals';
import {
  ExportHttpError,
  loadExportSettings,
  parseExportParams,
} from '../../../src/export/export-params.js';
import type { ExportSettings } from '../../../src/export/export-params.js';

// Réglages de référence des tests
const settings: ExportSettings = {
  maxRows: 1000,
  maxConcurrentPerIp: 2,
  maxConcurrentTotal: 2,
  timeoutMs: 1000,
  tmpDir: '/tmp/x',
};

/**
 * Parses a query and returns the raised export error.
 *
 * @param query - Query string parameters.
 * @returns The ExportHttpError thrown by the parser.
 */
const failure = (query: Record<string, unknown>): ExportHttpError => {
  try {
    parseExportParams(query, settings);
  } catch (error) {
    if (error instanceof ExportHttpError) return error;
    throw error;
  }
  throw new Error('parseExportParams did not throw');
};

describe('parseExportParams', () => {
  test('defaults: arrow, every column, cluster_by order, MAX_ROWS', () => {
    expect(parseExportParams({}, settings)).toEqual({
      catalog: null,
      schema: null,
      fields: null,
      filters: null,
      sort: null,
      format: 'arrow',
      limit: 1000,
      explicitLimit: false,
      after: null,
    });
  });

  test('parses every parameter', () => {
    const params = parseExportParams(
      {
        catalog: 'default',
        schema: 'geography',
        fields: 'region, population',
        filters: '{"children":[{"criterion":{"variable":"region","operation":"EQ","value":"A"}}]}',
        sort: 'population:DESC,region',
        format: 'CSV',
        limit: '10',
        after: 'abc',
      },
      settings,
    );

    expect(params).toEqual({
      catalog: 'default',
      schema: 'geography',
      fields: ['region', 'population'],
      filters: { children: [{ criterion: { variable: 'region', operation: 'EQ', value: 'A' } }] },
      sort: [
        { field: 'population', order: 'DESC' },
        { field: 'region', order: 'ASC' },
      ],
      format: 'csv',
      limit: 10,
      explicitLimit: true,
      after: 'abc',
    });
  });

  test('limit is capped by MAX_ROWS and stays explicit', () => {
    const params = parseExportParams({ limit: '999999' }, settings);
    expect(params.limit).toBe(1000);
    expect(params.explicitLimit).toBe(true);
  });

  test('a JSON body accepts native forms on top of the query string ones', () => {
    const filters = { children: [{ criterion: { variable: 'a,b', operation: 'IN', value: [1] } }] };
    const params = parseExportParams(
      {
        fields: ['a,b', ' c '],
        sort: ['a,b:desc', 'c'],
        filters,
        limit: 25,
        format: 'parquet',
      },
      settings,
      'body',
    );

    // Tableaux : une virgule reste dans le nom de colonne
    expect(params.fields).toEqual(['a,b', 'c']);
    expect(params.sort).toEqual([
      { field: 'a,b', order: 'DESC' },
      { field: 'c', order: 'ASC' },
    ]);
    expect(params.filters).toEqual(filters);
    expect(params.limit).toBe(25);
    expect(params.explicitLimit).toBe(true);

    // Les formes texte du GET restent valides dans un corps
    const asText = parseExportParams(
      { fields: 'x,y', filters: JSON.stringify(filters), limit: '3' },
      settings,
      'body',
    );
    expect(asText.fields).toEqual(['x', 'y']);
    expect(asText.filters).toEqual(filters);
    expect(asText.limit).toBe(3);
  });

  test.each([
    [{ fields: ['a', 1] }, 'array of strings'],
    [{ fields: { a: 1 } }, 'given once'],
    [{ filters: [1] }, 'JSON object of a FilterNode'],
    [{ filters: 3 }, 'JSON object of a FilterNode'],
    [{ limit: 2.5 }, 'positive integer'],
    [{ limit: -1 }, 'positive integer'],
    [{ after: 12 }, 'given once'],
    [{ where: {} }, 'Unknown parameter(s): where'],
  ])('400 for the body %j', (body, message) => {
    let error: unknown;
    try {
      parseExportParams(body, settings, 'body');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExportHttpError);
    expect((error as ExportHttpError).detail).toContain(message);
  });

  test('query strings keep refusing structured values', () => {
    expect(failure({ fields: ['a', 'b'] }).detail).toContain('given once');
  });

  test('any column name is accepted here; existence is checked against metadata later', () => {
    const params = parseExportParams(
      { fields: "taux chômage, zone d'emploi", sort: 'Année:desc', catalog: 'a"b', schema: 'x y' },
      settings,
    );
    expect(params.fields).toEqual(['taux chômage', "zone d'emploi"]);
    expect(params.sort).toEqual([{ field: 'Année', order: 'DESC' }]);
    // Catalogue et schéma : contrôlés contre leurs allow-lists par resolveExportTarget
    expect(params.catalog).toBe('a"b');
    expect(params.schema).toBe('x y');
  });

  test.each([
    [{ format: 'json' }, 'Unknown format'],
    [{ fields: 'a,,b' }, 'Empty field name'],
    [{ fields: 'a,a' }, 'given twice'],
    [{ sort: 'a:up' }, 'Invalid sort direction'],
    [{ sort: 'a:asc:x' }, 'Invalid sort item'],
    [{ sort: 'a,a:desc' }, 'given twice'],
    [{ sort: ':asc' }, 'Invalid sort item'],
    [{ filters: '[1,2]' }, 'JSON object of a FilterNode'],
    [{ filters: '{oops' }, 'not valid JSON'],
    [{ limit: '0' }, 'positive integer'],
    [{ limit: '1e3' }, 'positive integer'],
    [{ format: ['csv', 'arrow'] }, 'given once'],
    [{ where: 'x' }, 'Unknown parameter(s): where'],
  ])('400 for %j', (query, message) => {
    const error = failure(query);
    expect(error.status).toBe(400);
    expect(error.error).toBe('Invalid export parameter');
    expect(error.detail).toContain(message);
  });
});

describe('loadExportSettings', () => {
  test('coerces environment strings and falls back on invalid values', () => {
    const loaded = loadExportSettings({
      MAX_ROWS: '42',
      MAX_CONCURRENT_PER_IP: 'x',
      MAX_CONCURRENT_TOTAL: -1,
      TIMEOUT_MS: 5000,
      TMP_DIR: '',
    });

    expect(loaded.maxRows).toBe(42);
    expect(loaded.maxConcurrentPerIp).toBe(2);
    expect(loaded.maxConcurrentTotal).toBe(2);
    expect(loaded.timeoutMs).toBe(5000);
    expect(loaded.tmpDir).toMatch(/dashboard-api-export$/);
  });

  test('reads the EXPORT section of config/api.yaml', () => {
    const loaded = loadExportSettings();
    expect(loaded.maxRows).toBe(5_000_000);
    expect(loaded.timeoutMs).toBe(120_000);
  });
});
