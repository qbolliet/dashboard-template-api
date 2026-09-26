/**
 * HTTP integration tests of the export endpoint (GET /api/export).
 *
 * Drives the real route with supertest against the test DuckLake catalog
 * (npm run test:setup) and reads every file back: CSV compared line by line to
 * the source rows, Parquet re-read by DuckDB (types preserved), Arrow re-read
 * by apache-arrow (types and values). Also covers filters, projection, the
 * cluster_by default order, the row ceiling, the error statuses and the
 * concurrency gate.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import type { Response as SupertestResponse } from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tableFromIPC } from 'apache-arrow';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensureSetup } from '../unit/test_schema/test_resolvers/helpers.js';
import { databaseManager } from '../../src/db/index.js';
import { createExportRoutes } from '../../src/export/export-routes.js';
import { RateLimiter } from '../../src/security/rate-limiter.js';
import { createRateLimitMiddleware } from '../../src/security/rate-limit-middleware.js';
import type { ExportRoutesHandle } from '../../src/export/export-routes.js';
import type { ExportSettings } from '../../src/export/export-params.js';

// ─── Application de test ─────────────────────────────────────────────────────

// Répertoire temporaire propre à la suite (jamais le répertoire par défaut)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-it-'));

/**
 * Builds an Express app exposing only the export route.
 *
 * @param overrides - Settings replacing the test defaults.
 * @returns The app and the route handle (settings, gate).
 */
const buildApp = (
  overrides: Partial<ExportSettings> = {},
): { app: Express } & ExportRoutesHandle => {
  const app = express();
  const handle = createExportRoutes(app, {
    settings: {
      maxRows: 100_000,
      maxConcurrentPerIp: 2,
      maxConcurrentTotal: 2,
      timeoutMs: 30_000,
      tmpDir,
      ...overrides,
    },
  });
  return { app, ...handle };
};

/**
 * Supertest parser collecting a binary body into a Buffer.
 *
 * @param res - Incoming response stream.
 * @param callback - Receives the collected body.
 */
const binaryParser = (
  res: NodeJS.ReadableStream,
  callback: (err: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', (err: Error) => callback(err, Buffer.alloc(0)));
};

/**
 * Issues an export request and returns the raw body.
 *
 * @param app - Test application.
 * @param query - Query string parameters.
 * @returns The supertest response, body as a Buffer.
 */
const exportRequest = (app: Express, query: Record<string, string>): Promise<SupertestResponse> =>
  request(app)
    .get('/api/export')
    .query(query)
    .buffer(true)
    .parse(binaryParser as never);

/**
 * Runs a query on the API pool, rows converted by the API JSON converter.
 *
 * @param sql - Query to run.
 * @returns Rows as objects.
 */
const sourceRows = async (sql: string): Promise<Record<string, unknown>[]> => {
  const pool = databaseManager.getPool('default');
  const conn = await pool.acquire();
  try {
    return await conn.all(sql);
  } finally {
    pool.release(conn);
  }
};

/**
 * Describes the columns of a Parquet file with a standalone DuckDB instance.
 *
 * @param buffer - Parquet file content.
 * @returns Map column name → DuckDB type, plus the row count.
 */
const describeParquet = async (
  buffer: Buffer,
): Promise<{ types: Record<string, string>; rows: number }> => {
  const file = path.join(tmpDir, `reread-${Date.now()}.parquet`);
  fs.writeFileSync(file, buffer);
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    const target = file.split(path.sep).join('/');
    const described = await (
      await conn.run(`DESCRIBE SELECT * FROM read_parquet('${target}')`)
    ).getRowObjectsJson();
    const counted = await (
      await conn.run(`SELECT COUNT(*)::INTEGER AS n FROM read_parquet('${target}')`)
    ).getRowObjectsJson();
    const types: Record<string, string> = {};
    for (const row of described) types[String(row['column_name'])] = String(row['column_type']);
    return { types, rows: Number(counted[0]['n']) };
  } finally {
    conn.closeSync();
    instance.closeSync();
    fs.rmSync(file, { force: true });
  }
};

/**
 * Splits a CSV body into lines (the fixtures hold no quoted delimiter).
 *
 * @param body - CSV content.
 * @returns Non-empty lines, header first.
 */
const csvLines = (body: Buffer): string[] =>
  body
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '');

/**
 * Lists the export directories left in the suite's temporary directory.
 *
 * @returns Names of the remaining exp-* entries.
 */
const leftovers = (): string[] => fs.readdirSync(tmpDir).filter((e) => e.startsWith('exp-'));

/**
 * Waits until a condition holds, polling every 20 ms.
 *
 * The server releases the slot and removes the temporary file in `finally`,
 * which runs a few milliseconds AFTER the client has received the last byte.
 *
 * @param condition - Condition to wait for.
 * @param timeoutMs - Maximum wait.
 * @returns Whether the condition held before the timeout.
 */
const eventually = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};

// Formes de l'adresse de boucle locale vue par le serveur de supertest
const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '127.0.0.1', '::1'];

// Tri physique des schémas de test (cluster_by = clés primaires, spec §5.3)
const GEOGRAPHY_ORDER = 'region, departement, commune, date';
const GEOGRAPHY_TABLE = '"default".geography.fact_table';

beforeAll(async () => {
  await ensureSetup();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── CSV ─────────────────────────────────────────────────────────────────────

describe('GET /api/export — csv', () => {
  test('headers, column header and rows match the source query', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      fields: 'commune,date,population,budget',
      format: 'csv',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="default_geography_\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const expected = await sourceRows(
      `SELECT commune, date, population, budget FROM ${GEOGRAPHY_TABLE} ORDER BY ${GEOGRAPHY_ORDER}`,
    );
    const lines = csvLines(res.body as Buffer);
    expect(lines[0]).toBe('commune,date,population,budget');
    expect(lines).toHaveLength(expected.length + 1);
    expect(res.headers['x-row-count']).toBe(String(expected.length));

    // Comparaison ligne à ligne (NULL CSV = champ vide)
    expected.forEach((row, i) => {
      const cells = ['commune', 'date', 'population', 'budget'].map((c) =>
        row[c] === null ? '' : String(row[c]),
      );
      expect(lines[i + 1]).toBe(cells.join(','));
    });
  });

  test('timestamps are written in ISO 8601', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'main',
      fields: 'country,ingested_at',
      format: 'csv',
      limit: '5',
    });

    expect(res.status).toBe(200);
    const lines = csvLines(res.body as Buffer);
    expect(lines[0]).toBe('country,ingested_at');
    for (const line of lines.slice(1)) {
      const ts = line.split(',')[1];
      if (ts !== '') expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
    }
  });

  test('leaves no temporary file behind', async () => {
    const { app } = buildApp();
    await exportRequest(app, { catalog: 'default', schema: 'geography', format: 'csv' });
    await exportRequest(app, { catalog: 'default', schema: 'geography', format: 'parquet' });
    // Échec SQL impossible ici : un paramètre invalide échoue avant tout fichier
    await exportRequest(app, { catalog: 'default', schema: 'geography', format: 'xml' });
    expect(await eventually(() => leftovers().length === 0)).toBe(true);
  });
});

// ─── Parquet ─────────────────────────────────────────────────────────────────

describe('GET /api/export — parquet', () => {
  test('re-read by DuckDB with the database types preserved', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'parquet',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apache.parquet');
    expect(res.headers['content-disposition']).toMatch(/\.parquet"$/);

    const { types, rows } = await describeParquet(res.body as Buffer);
    expect(types).toEqual({
      region: 'VARCHAR',
      departement: 'VARCHAR',
      commune: 'VARCHAR',
      date: 'DATE',
      population: 'UBIGINT',
      area_km2: 'FLOAT',
      budget: 'BIGINT',
      density: 'DOUBLE',
      is_urban: 'BOOLEAN',
    });
    const [{ n }] = await sourceRows(`SELECT COUNT(*)::INTEGER AS n FROM ${GEOGRAPHY_TABLE}`);
    expect(rows).toBe(n);
    expect(res.headers['x-row-count']).toBe(String(n));
  });

  test('keeps TIMESTAMP, UINTEGER and FLOAT of the main schema', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'main',
      fields: 'ingested_at,sample_size,lower_bound,headcount',
      format: 'parquet',
    });

    expect(res.status).toBe(200);
    const { types } = await describeParquet(res.body as Buffer);
    expect(types).toEqual({
      ingested_at: 'TIMESTAMP',
      sample_size: 'UINTEGER',
      lower_bound: 'FLOAT',
      headcount: 'BIGINT',
    });
  });
});

// ─── Arrow ───────────────────────────────────────────────────────────────────

describe('GET /api/export — arrow', () => {
  test('is the default format, re-read by apache-arrow with types and values', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, { catalog: 'default', schema: 'geography' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apache.arrow.stream');
    expect(res.headers['content-disposition']).toMatch(/\.arrows"$/);
    expect(res.headers['x-row-count']).toBeUndefined();

    const table = tableFromIPC(res.body as Buffer);
    const typeOf = (name: string): string =>
      String(table.schema.fields.find((f) => f.name === name)?.type);
    expect(typeOf('population')).toBe('Uint64');
    expect(typeOf('budget')).toBe('Int64');
    expect(typeOf('area_km2')).toBe('Float32');
    expect(typeOf('density')).toBe('Float64');
    expect(typeOf('date')).toBe('Date32<DAY>');
    expect(typeOf('is_urban')).toBe('Bool');
    expect(typeOf('commune')).toBe('Utf8');

    const expected = await sourceRows(
      `SELECT commune, population, date, is_urban FROM ${GEOGRAPHY_TABLE} ORDER BY ${GEOGRAPHY_ORDER}`,
    );
    expect(table.numRows).toBe(expected.length);
    expected.forEach((row, i) => {
      const got = table.get(i)!.toJSON() as Record<string, unknown>;
      expect(got['commune']).toBe(row['commune']);
      expect(got['population'] === null ? null : String(got['population'])).toBe(
        row['population'] === null ? null : String(row['population']),
      );
      expect(got['is_urban']).toBe(row['is_urban']);
      const date = got['date'] as number | Date | null;
      expect(date === null ? null : new Date(date).toISOString().slice(0, 10)).toBe(row['date']);
    });
  });

  test('keeps TIMESTAMP (microseconds) and UINTEGER of the main schema', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'main',
      fields: 'ingested_at,sample_size,lower_bound',
      format: 'arrow',
      limit: '10',
    });

    expect(res.status).toBe(200);
    const table = tableFromIPC(res.body as Buffer);
    const types = table.schema.fields.map((f) => `${f.name}:${String(f.type)}`);
    expect(types).toEqual([
      'ingested_at:Timestamp<MICROSECOND>',
      'sample_size:Uint32',
      'lower_bound:Float32',
    ]);
    expect(table.numRows).toBe(10);
  });

  test('an empty result still carries its schema', async () => {
    const { app } = buildApp();
    const filters = JSON.stringify({
      children: [{ criterion: { variable: 'commune', operation: 'EQ', value: 'no-such-commune' } }],
    });
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      fields: 'commune,population',
      filters,
    });

    expect(res.status).toBe(200);
    const table = tableFromIPC(res.body as Buffer);
    expect(table.numRows).toBe(0);
    expect(table.schema.fields.map((f) => f.name)).toEqual(['commune', 'population']);
  });
});

// ─── Filtres, projection, ordre, plafond ─────────────────────────────────────

describe('GET /api/export — query shaping', () => {
  test('filters are applied (same FilterNode as GraphQL)', async () => {
    const { app } = buildApp();
    const [{ threshold }] = await sourceRows(
      `SELECT MEDIAN(population)::BIGINT AS threshold FROM ${GEOGRAPHY_TABLE}`,
    );
    const filters = JSON.stringify({
      children: [
        { criterion: { variable: 'population', operation: 'GT', value: Number(threshold) } },
        { connector: 'AND', criterion: { variable: 'is_urban', operation: 'IS_TRUE' } },
      ],
    });

    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'csv',
      fields: 'commune',
      filters,
    });

    expect(res.status).toBe(200);
    const [{ n }] = await sourceRows(
      `SELECT COUNT(*)::INTEGER AS n FROM ${GEOGRAPHY_TABLE} ` +
        `WHERE population > ${Number(threshold)} AND is_urban IS TRUE`,
    );
    expect(n).toBeGreaterThan(0);
    expect(res.headers['x-row-count']).toBe(String(n));
  });

  test('fields are projected in the requested order', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      fields: 'population,region',
      format: 'arrow',
    });

    const table = tableFromIPC(res.body as Buffer);
    expect(table.schema.fields.map((f) => f.name)).toEqual(['population', 'region']);
  });

  test('default order is cluster_by, explicit sort is honoured', async () => {
    const { app } = buildApp();
    const base = { catalog: 'default', schema: 'geography', format: 'csv' };

    const byDefault = await exportRequest(app, base);
    const byCluster = await exportRequest(app, {
      ...base,
      sort: 'region:asc,departement:asc,commune:asc,date:asc',
    });
    const reversed = await exportRequest(app, { ...base, sort: 'population:desc' });

    expect((byDefault.body as Buffer).equals(byCluster.body as Buffer)).toBe(true);

    const header = csvLines(reversed.body as Buffer)[0].split(',');
    const popIndex = header.indexOf('population');
    const populations = csvLines(reversed.body as Buffer)
      .slice(1)
      .map((line) => line.split(',')[popIndex])
      .filter((v) => v !== '')
      .map(Number);
    expect(populations).toEqual([...populations].sort((a, b) => b - a));
  });

  test('limit is honoured and capped by MAX_ROWS', async () => {
    const { app } = buildApp({ maxRows: 5 });
    const base = { catalog: 'default', schema: 'geography', format: 'csv' };

    const capped = await exportRequest(app, { ...base, limit: '1000' });
    const smaller = await exportRequest(app, { ...base, limit: '3' });
    const implicit = await exportRequest(app, base);

    expect(capped.headers['x-row-count']).toBe('5');
    expect(smaller.headers['x-row-count']).toBe('3');
    expect(implicit.headers['x-row-count']).toBe('5');
  });
});

// ─── Erreurs ─────────────────────────────────────────────────────────────────

describe('GET /api/export — errors', () => {
  test.each([
    [{ format: 'xml' }, 'Unknown format'],
    [{ fields: 'commune;DROP' }, 'Invalid field name'],
    [{ fields: 'no_such_column' }, 'Unknown column'],
    [{ sort: 'population:sideways' }, 'Invalid sort direction'],
    [{ filters: '{not json' }, 'not valid JSON'],
    [
      {
        filters: JSON.stringify({
          children: [{ criterion: { variable: 'population', operation: 'CONTAINS', value: 'x' } }],
        }),
      },
      'Allowed operations',
    ],
    [{ limit: '-3' }, 'positive integer'],
    [{ filter: '{}' }, 'Unknown parameter'],
  ])('400 for %j', async (query, message) => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/export')
      .query({ catalog: 'default', schema: 'geography', ...query });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid export parameter');
    expect(res.body.detail).toContain(message);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  test('404 for an unknown catalog or schema', async () => {
    const { app } = buildApp();
    const noCatalog = await request(app).get('/api/export').query({ catalog: 'nowhere' });
    const noSchema = await request(app)
      .get('/api/export')
      .query({ catalog: 'default', schema: 'nowhere' });

    expect(noCatalog.status).toBe(404);
    expect(noCatalog.body.error).toBe('Unknown catalog');
    expect(noSchema.status).toBe(404);
    expect(noSchema.body.error).toBe('Unknown schema');
  });

  test('409 with the version guard message for an unsupported schema', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/export')
      .query({ catalog: 'default', schema: 'unsupported_version' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Unsupported schema version');
    expect(res.body.detail).toContain('schema version 99 is not supported');
  });

  test('429 beyond the concurrent exports of a client, slot freed afterwards', async () => {
    const { app, gate } = buildApp({ maxConcurrentPerIp: 1, maxConcurrentTotal: 5 });
    const query = { catalog: 'default', schema: 'geography', format: 'csv' };

    // Créneau déjà pris par un export en cours du même client (IP de supertest)
    const held = LOOPBACK_KEYS.map((ip) => gate.tryAcquire(ip));
    const refused = await request(app).get('/api/export').query(query);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('Too many concurrent exports');
    expect(refused.body.detail).toContain('At most 1 concurrent export');

    held.forEach((slot) => slot.ok && slot.release());
    const again = await request(app).get('/api/export').query(query);
    expect(again.status).toBe(200);

    // Le créneau de l'export réussi est rendu en finally
    expect(await eventually(() => gate.activeCount() === 0)).toBe(true);
  });

  test('429 when the global ceiling is reached', async () => {
    const { app, gate } = buildApp({ maxConcurrentPerIp: 5, maxConcurrentTotal: 1 });
    const other = gate.tryAcquire('203.0.113.7');

    const res = await request(app)
      .get('/api/export')
      .query({ catalog: 'default', schema: 'geography' });
    expect(res.status).toBe(429);
    expect(res.body.detail).toContain('maximum of 1');

    if (other.ok) other.release();
  });

  test('the shared rate limiter runs before any export work', async () => {
    const limiter = new RateLimiter({
      MAX_REQUESTS: 1,
      WINDOW_MS: 60_000,
      MAX_BURST_REQUESTS: 100,
      BURST_WINDOW_MS: 60_000,
      TRUSTED_PROXIES: [],
    });
    const app = express();
    createExportRoutes(app, {
      rateLimit: createRateLimitMiddleware(limiter),
      settings: {
        maxRows: 10,
        maxConcurrentPerIp: 2,
        maxConcurrentTotal: 2,
        timeoutMs: 30_000,
        tmpDir,
      },
    });
    const query = { catalog: 'default', schema: 'geography', format: 'csv' };

    try {
      const first = await request(app).get('/api/export').query(query);
      const second = await request(app).get('/api/export').query(query);

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.body.error).toBe('Too many requests');
      expect(second.headers['retry-after']).toBeDefined();
    } finally {
      await limiter.stop();
    }
  });
});
