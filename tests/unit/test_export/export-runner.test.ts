/**
 * Tests of the export runners (src/export/export-runner.ts) on a real pool.
 *
 * Covers cancellation — the heart of the timeout and client-abort guards: a
 * slow synthetic query is interrupted, the runner rejects with the abort
 * reason, the temporary directory is removed and the connection, given back
 * to the pool, still serves queries. Also covers the startup purge of stale
 * temporary directories.
 */

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { PassThrough, Writable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Response } from 'express';
import { databaseManager } from '../../../src/db/index.js';
import type { ConnectionWrapper, DuckDBPool } from '../../../src/db/pool.js';
import {
  assertTmpSpace,
  purgeStaleExports,
  runArrowExport,
  runCopyExport,
} from '../../../src/export/export-runner.js';
import type { ExportRunContext } from '../../../src/export/export-runner.js';
import { ExportHttpError } from '../../../src/export/export-params.js';
import type { ExportDescription } from '../../../src/export/embedded-metadata.js';

// Requête volontairement lente (plusieurs secondes sans interruption)
const SLOW_QUERY = 'SELECT COUNT(*) AS n FROM range(3000000000) t(i) WHERE i % 7 = 3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-runner-'));
let pool: DuckDBPool;
let connection: ConnectionWrapper;

beforeAll(async () => {
  pool = databaseManager.getPool('default');
  connection = await pool.acquire();
});

afterAll(() => {
  pool.release(connection);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Description minimale embarquée par les exports parquet
const DESCRIPTION: ExportDescription = {
  columns: [],
  dataset: {
    label: null,
    description: null,
    source: null,
    updatedAt: '2024-01-01T00:00:00Z',
    schemaVersion: 2,
    clusterBy: [],
  },
};

/**
 * Builds a runner context around a sink stream standing for the response.
 *
 * @param sql - Query to export.
 * @param signal - Cancellation signal.
 * @param res - Stream standing for the response; a draining sink by default.
 * @returns The context and the callback spies.
 */
const makeContext = (
  sql: string,
  signal: AbortSignal,
  res: Writable = new PassThrough().resume() as unknown as Writable,
): { ctx: ExportRunContext; sendHeaders: jest.Mock; releaseConnection: jest.Mock } => {
  const sendHeaders = jest.fn();
  const releaseConnection = jest.fn();
  return {
    ctx: {
      connection,
      query: { sql, params: [], description: DESCRIPTION } as unknown as ExportRunContext['query'],
      res: res as unknown as Response,
      signal,
      sendHeaders: sendHeaders as unknown as ExportRunContext['sendHeaders'],
      releaseConnection,
    },
    sendHeaders,
    releaseConnection,
  };
};

/**
 * Aborts a controller after a delay, with a recognizable reason.
 *
 * @param delayMs - Delay before the abort.
 * @returns The controller and its reason.
 */
const abortAfter = (delayMs: number): { controller: AbortController; reason: Error } => {
  const controller = new AbortController();
  const reason = new Error('test timeout');
  setTimeout(() => controller.abort(reason), delayMs);
  return { controller, reason };
};

describe('runCopyExport', () => {
  test('writes the file, reports the row count and removes the temporary directory', async () => {
    const { ctx, sendHeaders } = makeContext(
      'SELECT i FROM range(10) t(i)',
      new AbortController().signal,
    );

    const rows = await runCopyExport(ctx, 'csv', tmpDir);

    expect(rows).toBe(10);
    // Taille exacte du fichier : « i\n0\n…9\n » = 2 + 10 × 2 octets
    expect(sendHeaders).toHaveBeenCalledWith(10, 22);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  test('bom prefixes the csv and is counted in the announced size', async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    });
    const { ctx, sendHeaders } = makeContext(
      'SELECT i FROM range(3) t(i)',
      new AbortController().signal,
      sink,
    );

    await runCopyExport(ctx, 'csv', tmpDir, { bom: true });

    const body = Buffer.concat(chunks);
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(body.subarray(3).toString()).toBe('i\n0\n1\n2\n');
    expect(sendHeaders).toHaveBeenCalledWith(3, body.length);
  });

  test('the connection is released once the file is written, before a slow client has read it', async () => {
    // Client lent : tampon minuscule, un morceau consommé toutes les 20 ms
    let received = 0;
    const slowSink = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _enc, done) {
        received += chunk.length;
        setTimeout(done, 20);
      },
    });
    const { ctx, releaseConnection } = makeContext(
      "SELECT i, repeat('x', 200) AS pad FROM range(20000) t(i)",
      new AbortController().signal,
      slowSink,
    );
    const receivedAtRelease: number[] = [];
    releaseConnection.mockImplementation(() => receivedAtRelease.push(received));

    const done = runCopyExport(ctx, 'csv', tmpDir);
    // Le transfert (≈ 4 Mo en morceaux de 64 Ko, 20 ms chacun) dure bien plus que le COPY
    await new Promise((resolve) => setTimeout(resolve, 50));
    await done;

    expect(releaseConnection).toHaveBeenCalledTimes(1);
    // À la remise, le client n'avait lu qu'une infime partie du fichier
    expect(receivedAtRelease[0]).toBeLessThan(received / 10);
  });

  test('parquet carries the compression codec and the embedded metadata', async () => {
    const { ctx } = makeContext('SELECT i FROM range(5) t(i)', new AbortController().signal);
    ctx.query.description = {
      columns: [],
      dataset: { ...DESCRIPTION.dataset, label: "L'été" },
    };
    const chunks: Buffer[] = [];
    ctx.res = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    }) as unknown as Response;

    await runCopyExport(ctx, 'parquet', tmpDir, { compression: 'zstd' });

    const file = path.join(tmpDir, 'reread.parquet');
    fs.writeFileSync(file, Buffer.concat(chunks));
    const target = file.split(path.sep).join('/');
    const codec = await connection.all(
      `SELECT DISTINCT compression FROM parquet_metadata('${target}')`,
    );
    const kv = await connection.all(
      `SELECT decode(key) AS k, decode(value) AS v FROM parquet_kv_metadata('${target}') ORDER BY k`,
    );
    fs.rmSync(file);

    expect(codec).toEqual([{ compression: 'ZSTD' }]);
    expect(kv.map((r) => r.k)).toEqual(['database.dataset', 'database.metadata']);
    expect(JSON.parse(String(kv[0].v)).label).toBe("L'été");
    expect(JSON.parse(String(kv[1].v))).toEqual([]);
  });

  test('an abort interrupts the COPY, cleans up and leaves the connection usable', async () => {
    const { controller, reason } = abortAfter(200);
    const { ctx, sendHeaders } = makeContext(SLOW_QUERY, controller.signal);
    const startedAt = Date.now();

    await expect(runCopyExport(ctx, 'parquet', tmpDir)).rejects.toBe(reason);

    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(sendHeaders).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(await connection.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });
});

describe('runArrowExport', () => {
  test('an abort interrupts the streamed query and leaves the connection usable', async () => {
    const { controller, reason } = abortAfter(200);
    const { ctx } = makeContext(SLOW_QUERY, controller.signal);
    const startedAt = Date.now();

    await expect(runArrowExport(ctx)).rejects.toBe(reason);

    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(await connection.all('SELECT 2 AS two')).toEqual([{ two: 2 }]);
  });

  test('an already aborted signal never reaches DuckDB', async () => {
    const controller = new AbortController();
    const reason = new Error('client gone');
    controller.abort(reason);
    const { ctx, sendHeaders } = makeContext('SELECT 1', controller.signal);

    await expect(runArrowExport(ctx)).rejects.toBe(reason);
    expect(sendHeaders).not.toHaveBeenCalled();
  });
});

describe('assertTmpSpace', () => {
  test('refuses with a 507 when the volume has less free space than required', async () => {
    const error = await assertTmpSpace(tmpDir, Number.MAX_SAFE_INTEGER).catch((e) => e);
    expect(error).toBeInstanceOf(ExportHttpError);
    expect(error.status).toBe(507);
    expect(error.detail).toMatch(/EXPORT\.TMP_MIN_FREE_MB/);
  });

  test('passes with a reachable threshold, and a threshold of 0 disables the check', async () => {
    await expect(assertTmpSpace(tmpDir, 1)).resolves.toBeUndefined();
    await expect(assertTmpSpace(tmpDir, 0)).resolves.toBeUndefined();
  });
});

describe('purgeStaleExports', () => {
  test('removes only the exp-* directories older than twice the timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-purge-'));
    const stale = path.join(root, 'exp-old');
    const fresh = path.join(root, 'exp-new');
    const foreign = path.join(root, 'other-old');
    [stale, fresh, foreign].forEach((dir) => fs.mkdirSync(dir));
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(foreign, old, old);

    const removed = await purgeStaleExports(root, 60_000);

    expect(removed).toBe(1);
    expect(fs.readdirSync(root).sort()).toEqual(['exp-new', 'other-old']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a missing directory is not an error', async () => {
    expect(await purgeStaleExports(path.join(tmpDir, 'absent'), 1000)).toBe(0);
  });
});
