/**
 * HTTP integration tests of the export endpoint (GET | POST /api/export).
 *
 * Drives the real route with supertest against the test DuckLake catalog
 * (npm run test:setup) and reads every file back: CSV compared line by line to
 * the source rows, Parquet re-read by DuckDB (types preserved), Arrow re-read
 * by apache-arrow (types and values). Also covers filters, projection, the
 * cluster_by default order, the row ceiling and its truncation signals (413,
 * X-Truncated), the resume cursor, the POST body, the error statuses and the
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
      transferTimeoutMs: 30_000,
      tmpDir,
      tmpMinFreeMb: 0,
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
 * Issues an export request with a JSON body and returns the raw body.
 *
 * @param app - Test application.
 * @param body - JSON body of export parameters.
 * @returns The supertest response, body as a Buffer.
 */
const exportPost = (app: Express, body: Record<string, unknown>): Promise<SupertestResponse> =>
  request(app)
    .post('/api/export')
    .send(body)
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
 * Reads the embedded key/value metadata and the codec of a Parquet file.
 *
 * @param buffer - Parquet file content.
 * @returns The key/value pairs (UTF-8 decoded) and the distinct compression codecs.
 */
const readParquetMetadata = async (
  buffer: Buffer,
): Promise<{ kv: Record<string, string>; codecs: string[] }> => {
  const file = path.join(tmpDir, `kv-${Date.now()}.parquet`);
  fs.writeFileSync(file, buffer);
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    const target = file.split(path.sep).join('/');
    const pairs = await (
      await conn.run(
        `SELECT decode(key) AS k, decode(value) AS v FROM parquet_kv_metadata('${target}')`,
      )
    ).getRowObjectsJson();
    const codecs = await (
      await conn.run(`SELECT DISTINCT compression AS c FROM parquet_metadata('${target}')`)
    ).getRowObjectsJson();
    return {
      kv: Object.fromEntries(pairs.map((row) => [String(row['k']), String(row['v'])])),
      codecs: codecs.map((row) => String(row['c'])),
    };
  } finally {
    conn.closeSync();
    instance.closeSync();
    fs.rmSync(file, { force: true });
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
 * Reads the rows of an exported file as comparable strings, in file order.
 *
 * @param format - Export format of the file.
 * @param body - File content.
 * @returns One string per data row (CSV header excluded).
 */
const rowsOf = async (format: string, body: Buffer): Promise<string[]> => {
  if (format === 'csv') return csvLines(body).slice(1);
  // Grands entiers (BIGINT, HUGEINT) sérialisés en texte
  const serialize = (row: unknown): string =>
    JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  if (format === 'arrow') {
    return tableFromIPC(body)
      .toArray()
      .map((row) => serialize((row as { toJSON: () => unknown }).toJSON()));
  }
  const file = path.join(tmpDir, `rows-${Date.now()}-${Math.random()}.parquet`);
  fs.writeFileSync(file, body);
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    const target = file.split(path.sep).join('/');
    const rows = await (await conn.run(`SELECT * FROM read_parquet('${target}')`)).getRowsJson();
    return rows.map(serialize);
  } finally {
    conn.closeSync();
    instance.closeSync();
    fs.rmSync(file, { force: true });
  }
};

/**
 * Fetches every page of an export by following X-Next-After.
 *
 * @param send - Issues one request, given the cursor of the page (none first).
 * @returns The responses, in page order.
 */
const fetchPages = async (
  send: (after: string | undefined) => Promise<SupertestResponse>,
): Promise<SupertestResponse[]> => {
  const pages: SupertestResponse[] = [];
  let after: string | undefined;
  do {
    const res = await send(after);
    expect(res.status).toBe(200);
    pages.push(res);
    after = res.headers['x-next-after'] as string | undefined;
  } while (after !== undefined && pages.length < 100);
  return pages;
};

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

    const table = tableFromIPC(res.body as Buffer);
    // Nombre de lignes connu avant le flux grâce à la sonde de comptage
    expect(res.headers['x-row-count']).toBe(String(table.numRows));
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

  test('columns named with spaces and accents are exported, filtered and sorted', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'emploi',
      fields: 'taux chômage,Année',
      sort: 'taux chômage:desc',
      filters: JSON.stringify({
        children: [{ criterion: { variable: 'taux chômage', operation: 'GT', value: 7 } }],
      }),
      format: 'arrow',
    });

    expect(res.status).toBe(200);
    const table = tableFromIPC(res.body as Buffer);
    expect(table.schema.fields.map((f) => f.name)).toEqual(['taux chômage', 'Année']);
    const rates = table.toArray().map((row) => Number(row['taux chômage']));
    // Fixture : 5 + 2 × rang de zone + 0,5 × (année − 2022), rangs 0 à 2
    expect(rates).toEqual([10, 9.5, 9, 8, 7.5]);
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

  test('a schema without primary key is exported in ORDER BY ALL order, ties broken by every column', async () => {
    const { app } = buildApp();
    const base = { catalog: 'default', schema: 'no_primary_key', format: 'csv', limit: '240' };
    // Ni cluster_by ni clé primaire : toutes les colonnes, dans l'ordre de la table
    const expected = (
      await sourceRows(
        'SELECT amount FROM "default".no_primary_key.fact_table ' +
          'ORDER BY label, observed_on, amount, slot, quantity',
      )
    ).map((row) => Number(row.amount));

    const amountsOf = (body: Buffer): number[] => {
      const [header, ...lines] = csvLines(body);
      const index = header.split(',').indexOf('amount');
      return lines.map((line) => Number(line.split(',')[index]));
    };

    const byDefault = await exportRequest(app, base);
    // `label` ne prend que 12 valeurs : le tri explicite laisse de nombreux ex æquo
    const byLabel = await exportRequest(app, { ...base, sort: 'label:asc' });

    expect(byDefault.status).toBe(200);
    expect(byDefault.headers['x-row-count']).toBe('240');
    expect(amountsOf(byDefault.body as Buffer)).toEqual(expected);
    expect(amountsOf(byLabel.body as Buffer)).toEqual(expected);
  });

  test('limit is honoured and capped by MAX_ROWS', async () => {
    const { app } = buildApp({ maxRows: 5 });
    const base = { catalog: 'default', schema: 'geography', format: 'csv' };

    const capped = await exportRequest(app, { ...base, limit: '1000' });
    const smaller = await exportRequest(app, { ...base, limit: '3' });

    expect(capped.headers['x-row-count']).toBe('5');
    expect(smaller.headers['x-row-count']).toBe('3');
  });
});

// ─── Erreurs ─────────────────────────────────────────────────────────────────

describe('GET /api/export — errors', () => {
  test.each([
    [{ format: 'xml' }, 'Unknown format'],
    // Tout nom est quoté : seule son absence de metadata le fait refuser
    [{ fields: 'commune;DROP' }, 'Unknown field column(s): "commune;DROP"'],
    [{ fields: 'no_such_column' }, 'Unknown field column(s): "no_such_column"'],
    [{ sort: 'no_such_column:desc' }, 'Unknown sort column(s): "no_such_column"'],
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
        transferTimeoutMs: 30_000,
        tmpDir,
        tmpMinFreeMb: 0,
      },
    });
    const query = { catalog: 'default', schema: 'geography', format: 'csv', limit: '10' };

    try {
      const first = await request(app).get('/api/export').query(query);
      // Même budget pour le POST : le limiteur précède le parseur du corps
      const second = await request(app).post('/api/export').send(query);

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.body.error).toBe('Too many requests');
      expect(second.headers['retry-after']).toBeDefined();
    } finally {
      await limiter.stop();
    }
  });
});

// ─── Troncature et reprise au-delà de MAX_ROWS ───────────────────────────────

// Les trois formats, chacun relu dans son propre lecteur
const FORMATS = ['csv', 'parquet', 'arrow'] as const;

// Schéma sans clé primaire de 240 lignes : trois pages de 100
const NO_KEY = { catalog: 'default', schema: 'no_primary_key' };

describe('/api/export — truncation signals', () => {
  test.each(FORMATS)('413 without limit beyond MAX_ROWS (%s)', async (format) => {
    const { app } = buildApp({ maxRows: 100 });
    const res = await exportRequest(app, { ...NO_KEY, format });

    expect(res.status).toBe(413);
    const body = JSON.parse((res.body as Buffer).toString('utf8'));
    expect(body.error).toBe('Export too large');
    expect(body.detail).toContain('240 rows');
    expect(body.detail).toContain('ceiling of 100');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['x-total-count']).toBeUndefined();
  });

  test.each(FORMATS)(
    'an explicit limit is truncated with X-Truncated and X-Next-After (%s)',
    async (format) => {
      const { app } = buildApp({ maxRows: 100 });
      const smaller = await exportRequest(app, { ...NO_KEY, format, limit: '50' });
      // Au-delà du plafond : ramenée à MAX_ROWS, et signalée de même
      const capped = await exportRequest(app, { ...NO_KEY, format, limit: '5000' });

      for (const [res, rows] of [
        [smaller, 50],
        [capped, 100],
      ] as const) {
        expect(res.status).toBe(200);
        expect(res.headers['x-truncated']).toBe('true');
        expect(res.headers['x-total-count']).toBe('240');
        expect(res.headers['x-row-count']).toBe(String(rows));
        expect(res.headers['x-next-after']).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(await rowsOf(format, res.body as Buffer)).toHaveLength(rows);
      }
      expect(smaller.headers['access-control-expose-headers']).toContain('X-Next-After');
    },
  );

  test.each(FORMATS)('no truncation signal when every row fits (%s)', async (format) => {
    const { app } = buildApp({ maxRows: 1000 });
    const res = await exportRequest(app, { ...NO_KEY, format });

    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBe('240');
    expect(res.headers['x-row-count']).toBe('240');
    expect(res.headers['x-truncated']).toBeUndefined();
    expect(res.headers['x-next-after']).toBeUndefined();
  });
});

describe('/api/export — resume with after', () => {
  // Chaque cas : paramètres, taille de page ; tous passent par plusieurs pages
  const CASES: Array<[string, Record<string, unknown>, number]> = [
    ['primary key schema (main, 1 700+ rows)', { catalog: 'default', schema: 'main' }, 100],
    // commune NULL dans la clé primaire (arbre irrégulier)
    ['NULL in the primary key (geography)', { catalog: 'default', schema: 'geography' }, 3],
    [
      'nullable sort column (geography, density desc)',
      { catalog: 'default', schema: 'geography', sort: 'density:desc' },
      4,
    ],
    ['no primary key, ORDER BY ALL', NO_KEY, 100],
    ['no primary key, sort with ties', { ...NO_KEY, sort: 'label:asc' }, 100],
    [
      'no primary key, filter and projection without the key columns',
      {
        ...NO_KEY,
        fields: 'quantity,label',
        sort: 'quantity:desc',
        filters: JSON.stringify({
          children: [
            { criterion: { variable: 'observed_on', operation: 'AFTER', value: '2024-03-05' } },
          ],
        }),
      },
      30,
    ],
  ];

  test.each(
    FORMATS.flatMap((format) => CASES.map(([name, query, size]) => [format, name, query, size])),
  )('pages concatenate to the uncapped export (%s, %s)', async (format, _name, query, size) => {
    const params = { ...(query as Record<string, string>), format: format as string };
    const pageSize = size as number;
    const whole = await exportRequest(buildApp().app, params);
    expect(whole.status).toBe(200);
    const expected = await rowsOf(format as string, whole.body as Buffer);

    const { app } = buildApp({ maxRows: 100 });
    const pages = await fetchPages((after) =>
      exportRequest(app, { ...params, limit: String(pageSize), ...(after ? { after } : {}) }),
    );

    expect(pages.length).toBe(Math.max(1, Math.ceil(expected.length / pageSize)));
    expect(pages.length).toBeGreaterThan(1);
    const got: string[] = [];
    for (const page of pages) got.push(...(await rowsOf(format as string, page.body as Buffer)));
    expect(got).toEqual(expected);
    // Total restant décroissant d'une page à l'autre
    expect(pages.map((p) => Number(p.headers['x-total-count']))).toEqual(
      pages.map((_, i) => expected.length - i * pageSize),
    );
  });

  test('the cursor also travels in a POST body', async () => {
    const params = { ...NO_KEY, format: 'csv', sort: ['label:desc'] };
    const whole = await exportPost(buildApp().app, params);
    const { app } = buildApp({ maxRows: 100 });
    const pages = await fetchPages((after) =>
      exportPost(app, { ...params, limit: 100, ...(after ? { after } : {}) }),
    );

    expect(pages).toHaveLength(3);
    const got: string[] = [];
    for (const page of pages) got.push(...(await rowsOf('csv', page.body as Buffer)));
    expect(got).toEqual(await rowsOf('csv', whole.body as Buffer));
  });

  test('400 for a malformed cursor or one issued for another sort', async () => {
    const { app } = buildApp({ maxRows: 100 });
    const first = await exportRequest(app, { ...NO_KEY, format: 'csv', limit: '100' });
    const after = first.headers['x-next-after'] as string;

    const malformed = await request(app)
      .get('/api/export')
      .query({ ...NO_KEY, limit: '100', after: 'not-a-cursor' });
    const otherSort = await request(app)
      .get('/api/export')
      .query({ ...NO_KEY, limit: '100', sort: 'label:desc', after });

    for (const res of [malformed, otherSort]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid export parameter');
      expect(res.body.detail).toContain('Invalid "after" cursor');
    }
    expect(otherSort.body.detail).toContain('another sort');
  });
});

// ─── POST : paramètres dans un corps JSON ────────────────────────────────────

describe('POST /api/export', () => {
  test('an IN of 1 000 values, too long for a URL, is accepted', async () => {
    const { app } = buildApp();
    const communes = (
      await sourceRows(`SELECT DISTINCT commune FROM ${GEOGRAPHY_TABLE} WHERE commune IS NOT NULL`)
    ).map((row) => String(row.commune));
    const values = [
      ...communes,
      ...Array.from({ length: 1000 - communes.length }, (_, i) => `commune-inexistante-${i}`),
    ];

    const res = await exportPost(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'csv',
      fields: ['commune'],
      filters: {
        children: [{ criterion: { variable: 'commune', operation: 'IN', value: values } }],
      },
    });

    expect(res.status).toBe(200);
    const [{ n }] = await sourceRows(
      `SELECT COUNT(*)::INTEGER AS n FROM ${GEOGRAPHY_TABLE} WHERE commune IS NOT NULL`,
    );
    expect(res.headers['x-row-count']).toBe(String(n));
  });

  test('native JSON forms give the same file as the equivalent GET', async () => {
    const { app } = buildApp();
    const filters = {
      children: [{ criterion: { variable: 'population', operation: 'GT', value: 50_000 } }],
    };
    const viaGet = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'csv',
      fields: 'commune,population',
      sort: 'population:desc,commune:asc',
      filters: JSON.stringify(filters),
      limit: '8',
    });
    const viaPost = await exportPost(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'csv',
      fields: ['commune', 'population'],
      sort: ['population:desc', 'commune:asc'],
      filters,
      limit: 8,
    });

    expect(viaPost.status).toBe(200);
    expect(viaPost.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect((viaPost.body as Buffer).equals(viaGet.body as Buffer)).toBe(true);
  });

  test('400 for an unknown key, a non-object body, invalid JSON or a query string', async () => {
    const { app } = buildApp();
    const unknownKey = await request(app)
      .post('/api/export')
      .send({ catalog: 'default', schema: 'geography', filter: {} });
    const arrayBody = await request(app)
      .post('/api/export')
      .send([{ catalog: 'default' }]);
    const invalidJson = await request(app)
      .post('/api/export')
      .set('Content-Type', 'application/json')
      .send('{"catalog": ');
    const withQuery = await request(app)
      .post('/api/export')
      .query({ format: 'csv' })
      .send({ catalog: 'default', schema: 'geography' });

    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.detail).toContain('Unknown parameter(s): filter');
    expect(arrayBody.status).toBe(400);
    expect(arrayBody.body.detail).toContain('must be a JSON object');
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body.detail).toContain('not valid JSON');
    expect(withQuery.status).toBe(400);
    expect(withQuery.body.detail).toContain('JSON body only');
  });

  test('415 for a body that is not JSON', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/export')
      .type('form')
      .send({ catalog: 'default', schema: 'geography' });

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('Unsupported media type');
  });
});

// ─── Métadonnées embarquées, options de format et garde-fous de transfert ────

describe('/api/export — embedded metadata', () => {
  /**
   * Reads the metadata and dataset_metadata tables of the geography schema.
   *
   * @returns The metadata rows (snake_case) and the single dataset row.
   */
  const sourceDescription = async (): Promise<{
    columns: Record<string, unknown>[];
    dataset: Record<string, unknown>;
  }> => {
    const columns = await sourceRows('SELECT * FROM "default".geography.metadata');
    const [dataset] = await sourceRows('SELECT * FROM "default".geography.dataset_metadata');
    return { columns, dataset };
  };

  test('parquet carries database.metadata and database.dataset, read back by DuckDB', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'parquet',
    });
    expect(res.status).toBe(200);

    const { kv } = await readParquetMetadata(res.body as Buffer);
    expect(
      Object.keys(kv)
        .filter((k) => k.startsWith('database.'))
        .sort(),
    ).toEqual(['database.dataset', 'database.metadata']);

    const source = await sourceDescription();
    const rows = JSON.parse(kv['database.metadata']) as Record<string, unknown>[];
    expect(rows.map((r) => r['name']).sort()).toEqual(source.columns.map((c) => c['name']).sort());
    for (const row of rows) {
      const origin = source.columns.find((c) => c['name'] === row['name'])!;
      expect(row['label']).toBe(origin['label']);
      expect(row['sqlType']).toBe(origin['sql_type']);
      expect(row['unit']).toBe(origin['unit'] ?? null);
      expect(row['isPrimaryKey']).toBe(Boolean(origin['is_primary_key']));
      expect(row['typeFamily']).toEqual(expect.any(String));
    }
    expect(rows.find((r) => r['name'] === 'population')!['typeFamily']).toBe('INTEGER');

    const dataset = JSON.parse(kv['database.dataset']) as Record<string, unknown>;
    expect(dataset['label']).toBe(source.dataset['label'] ?? null);
    expect(dataset['schemaVersion']).toBe(Number(source.dataset['schema_version']));
    expect(dataset['clusterBy']).toEqual(expect.any(Array));
  });

  test('a projected parquet describes the exported columns only, in the requested order', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'parquet',
      fields: 'population,region',
    });

    const { kv } = await readParquetMetadata(res.body as Buffer);
    const rows = JSON.parse(kv['database.metadata']) as Record<string, unknown>[];
    expect(rows.map((r) => r['name'])).toEqual(['population', 'region']);
  });

  test('arrow carries per-field metadata and the same two schema pairs', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'arrow',
    });
    expect(res.status).toBe(200);

    const table = tableFromIPC(new Uint8Array(res.body as Buffer));
    const source = await sourceDescription();
    for (const field of table.schema.fields) {
      const origin = source.columns.find((c) => c['name'] === field.name)!;
      expect(field.metadata.get('label')).toBe(origin['label']);
      expect(field.metadata.get('isPrimaryKey')).toBe(String(Boolean(origin['is_primary_key'])));
      expect(field.metadata.get('unit') ?? null).toBe(origin['unit'] ?? null);
      expect(field.metadata.get('labelFor') ?? null).toBe(origin['label_for'] ?? null);
    }

    const rows = JSON.parse(table.schema.metadata.get('database.metadata')!) as unknown[];
    expect(rows).toHaveLength(source.columns.length);
    expect(JSON.parse(table.schema.metadata.get('database.dataset')!)).toMatchObject({
      schemaVersion: Number(source.dataset['schema_version']),
    });
  });

  test('csv stays free of embedded metadata', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'csv',
    });

    expect((res.body as Buffer).toString('utf8')).not.toContain('database.');
  });
});

describe('/api/export — format options', () => {
  test('bom=1 prefixes the csv with the UTF-8 mark and Content-Length counts it', async () => {
    const { app } = buildApp();
    const query = { catalog: 'default', schema: 'geography', format: 'csv' };
    const plain = await exportRequest(app, query);
    const withBom = await exportRequest(app, { ...query, bom: '1' });

    expect(withBom.status).toBe(200);
    const body = withBom.body as Buffer;
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(body.subarray(3).equals(plain.body as Buffer)).toBe(true);
    expect(withBom.headers['content-length']).toBe(String(body.length));
    expect((plain.body as Buffer)[0]).not.toBe(0xef);
  });

  test('compression=zstd is honoured and the file is read back by DuckDB', async () => {
    const { app } = buildApp();
    const query = { catalog: 'default', schema: 'geography', format: 'parquet' };
    const zstd = await exportRequest(app, { ...query, compression: 'zstd' });
    const gzip = await exportRequest(app, { ...query, compression: 'gzip' });
    const dflt = await exportRequest(app, query);

    expect((await readParquetMetadata(zstd.body as Buffer)).codecs).toEqual(['ZSTD']);
    expect((await readParquetMetadata(gzip.body as Buffer)).codecs).toEqual(['GZIP']);
    expect((await readParquetMetadata(dflt.body as Buffer)).codecs).toEqual(['SNAPPY']);
    const { rows } = await describeParquet(zstd.body as Buffer);
    const [{ n }] = await sourceRows(`SELECT COUNT(*)::INTEGER AS n FROM ${GEOGRAPHY_TABLE}`);
    expect(rows).toBe(n);
  });

  test.each([
    [{ format: 'parquet', bom: '1' }, 'only applies to format=csv'],
    [{ format: 'csv', compression: 'zstd' }, 'only applies to format=parquet'],
    [{ format: 'parquet', compression: 'lz4' }, 'Unknown compression'],
    [{ format: 'csv', bom: 'maybe' }, 'must be 1, 0, true or false'],
  ])('400 for %j', async (query, message) => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/export')
      .query({ catalog: 'default', schema: 'geography', ...query });

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain(message);
  });

  test('the POST body takes the options too', async () => {
    const { app } = buildApp();
    const res = await exportPost(app, {
      catalog: 'default',
      schema: 'geography',
      format: 'csv',
      bom: true,
    });

    expect((res.body as Buffer)[0]).toBe(0xef);
  });
});

describe('/api/export — transfer guards', () => {
  test.each([
    ['csv', {}],
    ['parquet', {}],
    ['parquet', { compression: 'zstd' }],
  ])('Content-Length is the exact size of the %s body %j', async (format, extra) => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      format,
      ...extra,
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String((res.body as Buffer).length));
    expect(res.headers['transfer-encoding']).toBeUndefined();
  });

  test('arrow is streamed without a Content-Length', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, { catalog: 'default', schema: 'geography' });

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBeUndefined();
  });

  test('the pool connection is back once a csv/parquet response is complete', async () => {
    const pool = databaseManager.getPool('default');
    const before = pool.getStats().using;
    const { app } = buildApp();
    await exportRequest(app, { catalog: 'default', schema: 'geography', format: 'parquet' });

    expect(pool.getStats().using).toBe(before);
  });

  test('507 when the temporary volume has less free space than EXPORT.TMP_MIN_FREE_MB', async () => {
    const { app } = buildApp({ tmpMinFreeMb: Number.MAX_SAFE_INTEGER });
    const query = { catalog: 'default', schema: 'geography' };

    for (const format of ['csv', 'parquet']) {
      const res = await request(app)
        .get('/api/export')
        .query({ ...query, format });
      expect(res.status).toBe(507);
      expect(res.body.error).toBe('Insufficient storage');
      expect(res.body.detail).toContain('EXPORT.TMP_MIN_FREE_MB');
      expect(res.headers['content-disposition']).toBeUndefined();
    }
    // Arrow n'utilise aucun fichier temporaire : pas concerné
    const arrow = await exportRequest(app, query);
    expect(arrow.status).toBe(200);
    expect(fs.readdirSync(tmpDir).filter((entry) => entry.startsWith('exp-'))).toEqual([]);
  });
});

// ─── Export agrégé ───────────────────────────────────────────────────────────

describe('/api/export — aggregated', () => {
  // Référence : mêmes agrégats calculés directement sur la table de faits
  const TRADE_REFERENCE = `
    SELECT nc8, SUM(value) AS value_sum, AVG(value) AS moyenne, COUNT(*) AS row_count
    FROM "default".trade.fact_table GROUP BY nc8 ORDER BY nc8`;

  test('arrow: rows of getAggregates, aggregate metadata on fields and schema', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'trade',
      groupBy: 'nc8',
      aggregates: 'value:sum,value:avg:moyenne',
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBe('5');

    const table = tableFromIPC(new Uint8Array(res.body as Buffer));
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      'nc8',
      'nc8__label',
      'value_sum',
      'moyenne',
      'row_count',
    ]);

    const reference = await sourceRows(TRADE_REFERENCE);
    const rows = table
      .toArray()
      .map((row) => (row as { toJSON: () => Record<string, unknown> }).toJSON());
    expect(rows.map((row) => row.nc8)).toEqual(reference.map((row) => row.nc8));
    rows.forEach((row, i) => {
      expect(row.value_sum).toBeCloseTo(Number(reference[i].value_sum), 6);
      expect(row.moyenne).toBeCloseTo(Number(reference[i].moyenne), 6);
      expect(Number(row.row_count)).toBe(Number(reference[i].row_count));
    });

    // Champs : agrégat décrit par sa mesure, libellé rattaché à la colonne de groupe
    const field = (name: string) => table.schema.fields.find((f) => f.name === name)!.metadata;
    expect(field('value_sum').get('measure')).toBe('value');
    expect(field('value_sum').get('aggregation')).toBe('SUM');
    expect(field('value_sum').get('unit')).toBe('€');
    expect(field('moyenne').get('aggregation')).toBe('AVG');
    expect(field('nc8__label').get('labelFor')).toBe('nc8');
    expect(field('nc8').get('label')).toBe('Code NC8');

    const aggregation = JSON.parse(table.schema.metadata.get('database.aggregation')!) as {
      groupBy: Array<{ name: string; labelColumn: string | null }>;
      aggregates: Array<{ alias: string; aggregation: string }>;
      rowCountColumn: string;
    };
    expect(aggregation.groupBy).toMatchObject([{ name: 'nc8', labelColumn: 'nc8__label' }]);
    expect(aggregation.aggregates.map((a) => [a.alias, a.aggregation])).toEqual([
      ['value_sum', 'SUM'],
      ['moyenne', 'AVG'],
    ]);
    expect(aggregation.rowCountColumn).toBe('row_count');
    const sources = JSON.parse(table.schema.metadata.get('database.metadata')!) as Array<{
      name: string;
    }>;
    expect(sources.map((s) => s.name)).toEqual(['nc8', 'nc8_libelle_en', 'value']);
  });

  test('parquet: the SUM of a BIGINT is read back as DECIMAL(38,0), exact beyond 2^53', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      groupBy: 'region',
      aggregates: 'budget:sum',
      format: 'parquet',
    });
    expect(res.status).toBe(200);

    const { types } = await describeParquet(res.body as Buffer);
    expect(types['budget_sum']).toBe('DECIMAL(38,0)');

    const reference = await sourceRows(
      'SELECT region, SUM(budget)::VARCHAR AS s FROM "default".geography.fact_table ' +
        'GROUP BY region ORDER BY region',
    );
    const rows = (await rowsOf('parquet', res.body as Buffer)).map(
      (line) => JSON.parse(line) as unknown[],
    );
    // Colonnes : region, budget_sum, row_count (region sans libellé)
    expect(rows.map((row) => [row[0], String(row[1])])).toEqual(
      reference.map((row) => [row.region, row.s]),
    );
    expect(Number(reference[0].s)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

    const { kv } = await readParquetMetadata(res.body as Buffer);
    expect(JSON.parse(kv['database.aggregation'])).toMatchObject({
      aggregates: [{ alias: 'budget_sum', measure: 'budget', aggregation: 'SUM' }],
    });
  });

  test('csv: header and rows, filter applied before grouping, grain honoured', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'geography',
      groupBy: 'date:year',
      aggregates: 'population:max',
      filters: JSON.stringify({
        children: [{ criterion: { variable: 'region', operation: 'EQ', value: 'Île-de-France' } }],
      }),
      format: 'csv',
    });
    expect(res.status).toBe(200);

    const lines = csvLines(res.body as Buffer);
    expect(lines[0]).toBe('date,population_max,row_count');
    const reference = await sourceRows(
      `SELECT CAST(date_trunc('year', date) AS DATE)::VARCHAR AS d, MAX(population) AS m,
              COUNT(*) AS n FROM "default".geography.fact_table WHERE region = 'Île-de-France'
       GROUP BY 1 ORDER BY 1`,
    );
    expect(reference.length).toBeGreaterThan(0);
    expect(lines.slice(1)).toEqual(reference.map((row) => `${row.d},${row.m},${row.n}`));
  });

  test('a sort on an aggregate resumes page by page with after', async () => {
    const { app } = buildApp();
    const base = {
      catalog: 'default',
      schema: 'trade',
      groupBy: 'nc8,partner_code',
      aggregates: 'value:sum',
      sort: 'value_sum:desc',
      format: 'csv',
    };
    const whole = await exportRequest(app, base);
    expect(whole.status).toBe(200);
    const expected = csvLines(whole.body as Buffer).slice(1);
    expect(expected).toHaveLength(15);

    const pages = await fetchPages((after) =>
      exportRequest(app, { ...base, limit: '4', ...(after ? { after } : {}) }),
    );
    expect(pages).toHaveLength(4);
    expect(pages.flatMap((page) => csvLines(page.body as Buffer).slice(1))).toEqual(expected);
  });

  test('the POST body takes groupBy and aggregates as arrays', async () => {
    const { app } = buildApp();
    const get = await exportRequest(app, {
      catalog: 'default',
      schema: 'trade',
      groupBy: 'nc8',
      aggregates: 'value:sum,value:avg:moyenne',
      format: 'csv',
    });
    const post = await exportPost(app, {
      catalog: 'default',
      schema: 'trade',
      groupBy: ['nc8'],
      aggregates: ['value:sum', 'value:avg:moyenne'],
      format: 'csv',
    });
    expect(post.status).toBe(200);
    expect((post.body as Buffer).toString('utf8')).toBe((get.body as Buffer).toString('utf8'));
  });

  test('without groupBy: a single global row', async () => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'trade',
      aggregates: 'value',
      format: 'csv',
    });
    expect(res.status).toBe(200);
    const [reference] = await sourceRows(
      'SELECT SUM(value)::VARCHAR AS s, COUNT(*) AS n FROM "default".trade.fact_table',
    );
    const lines = csvLines(res.body as Buffer);
    expect(lines[0]).toBe('value_sum,row_count');
    expect(lines.slice(1)).toEqual([`${reference.s},${reference.n}`]);
  });

  test.each([
    [{ groupBy: 'nc8' }, /requires "aggregates"/],
    [{ aggregates: 'value', fields: 'nc8' }, /"fields" does not apply/],
    [{ aggregates: 'value:total' }, /Unknown aggregation "total"/],
    [{ aggregates: 'value', groupBy: 'nc8:decade' }, /Unknown grain "decade"/],
    [{ aggregates: 'nope' }, /Unknown measure/],
    [{ aggregates: 'value', groupBy: 'nc8', sort: 'value' }, /Unknown sort column/],
    [{ aggregates: 'nc8_libelle_en:sum' }, /not allowed/],
  ])('400 for %j', async (query, message) => {
    const { app } = buildApp();
    const res = await exportRequest(app, {
      catalog: 'default',
      schema: 'trade',
      ...(query as Record<string, string>),
    });
    expect(res.status).toBe(400);
    const body = JSON.parse((res.body as Buffer).toString('utf8')) as { detail: string };
    expect(body.detail).toMatch(message);
  });
});
