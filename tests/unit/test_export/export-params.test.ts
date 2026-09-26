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
  parseExportQuery,
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
    parseExportQuery(query, settings);
  } catch (error) {
    if (error instanceof ExportHttpError) return error;
    throw error;
  }
  throw new Error('parseExportQuery did not throw');
};

describe('parseExportQuery', () => {
  test('defaults: arrow, every column, cluster_by order, MAX_ROWS', () => {
    expect(parseExportQuery({}, settings)).toEqual({
      catalog: null,
      schema: null,
      fields: null,
      filters: null,
      sort: null,
      format: 'arrow',
      limit: 1000,
    });
  });

  test('parses every parameter', () => {
    const params = parseExportQuery(
      {
        catalog: 'default',
        schema: 'geography',
        fields: 'region, population',
        filters: '{"children":[{"criterion":{"variable":"region","operation":"EQ","value":"A"}}]}',
        sort: 'population:DESC,region',
        format: 'CSV',
        limit: '10',
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
    });
  });

  test('limit is capped by MAX_ROWS', () => {
    expect(parseExportQuery({ limit: '999999' }, settings).limit).toBe(1000);
  });

  test.each([
    [{ format: 'json' }, 'Unknown format'],
    [{ fields: 'a,b;c' }, 'Invalid field name'],
    [{ fields: 'a,a' }, 'given twice'],
    [{ sort: 'a:up' }, 'Invalid sort direction'],
    [{ sort: 'a:asc:x' }, 'Invalid sort item'],
    [{ sort: 'a,a:desc' }, 'given twice'],
    [{ sort: '1abc' }, 'Invalid sort field name'],
    [{ catalog: 'a"b' }, 'Invalid catalog name'],
    [{ schema: 'main; DROP' }, 'Invalid schema name'],
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
