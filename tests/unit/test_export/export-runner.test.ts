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
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Response } from 'express';
import { databaseManager } from '../../../src/db/index.js';
import type { ConnectionWrapper, DuckDBPool } from '../../../src/db/pool.js';
import {
  purgeStaleExports,
  runArrowExport,
  runCopyExport,
} from '../../../src/export/export-runner.js';
import type { ExportRunContext } from '../../../src/export/export-runner.js';

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

/**
 * Builds a runner context around a sink stream standing for the response.
 *
 * @param sql - Query to export.
 * @param signal - Cancellation signal.
 * @returns The context and the header callback spy.
 */
const makeContext = (
  sql: string,
  signal: AbortSignal,
): { ctx: ExportRunContext; sendHeaders: jest.Mock } => {
  const sink = new PassThrough();
  sink.resume();
  const sendHeaders = jest.fn();
  return {
    ctx: {
      connection,
      query: { sql, params: [] },
      res: sink as unknown as Response,
      signal,
      sendHeaders: sendHeaders as unknown as ExportRunContext['sendHeaders'],
    },
    sendHeaders,
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
    expect(sendHeaders).toHaveBeenCalledWith(10);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
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
