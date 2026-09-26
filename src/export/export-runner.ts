// Importation des modules
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { once } from 'events';
import { pipeline } from 'stream/promises';
import { RecordBatchStreamWriter } from 'apache-arrow';
import type { Response } from 'express';
import type { DuckDBMaterializedResult, DuckDBResult } from '@duckdb/node-api';
import { bindParam, escapeSqlString } from '../db/pool.js';
import type { ConnectionWrapper } from '../db/pool.js';
import { buildArrowLayout, chunkToRecordBatch, emptyRecordBatch } from './arrow-writer.js';
import { FORMAT_SPECS } from './export-params.js';
import type { ExportQuery } from './build-export-query.js';

// ─── Contexte d'exécution ────────────────────────────────────────────────────

/**
 * Execution of an export on a pool connection.
 *
 * Choices, verified on @duckdb/node-api 1.5.2-r.2 against a READ_ONLY DuckLake
 * catalog:
 * - csv / parquet: `COPY (SELECT …) TO '<tmp file>'` — DuckDB writes natively
 *   (parallel, types preserved), `rowsChanged` gives the exact row count for
 *   free, and the file is then streamed to the response. Writing a local file
 *   is allowed: only the catalog is read-only, not the in-memory instance.
 * - arrow: streamed result (`prepared.stream()`), each 2048-row chunk turned
 *   into a RecordBatch and written as an IPC stream. No temporary file.
 *
 * Cancellation (timeout, client abort) goes through one AbortSignal:
 * `connection.interrupt()` while DuckDB is working, stream destruction while
 * bytes are flowing. An interrupted streaming scan ends its iteration WITHOUT
 * error, hence the explicit check of the signal after every DuckDB step.
 */

/** Everything a runner needs to serve one export. */
interface ExportRunContext {
  connection: ConnectionWrapper;
  query: ExportQuery;
  res: Response;
  /** Aborted on timeout or client disconnection; its reason is the error to report. */
  signal: AbortSignal;
  /** Sends the response headers; rowCount is null when unknown before streaming. */
  sendHeaders: (rowCount: number | null) => void;
}

// Options CSV : en-tête de colonnes, dates et horodatages au format ISO 8601
const CSV_COPY_OPTIONS =
  "FORMAT CSV, HEADER, DATEFORMAT '%Y-%m-%d', TIMESTAMPFORMAT '%Y-%m-%dT%H:%M:%S.%f'";

// Préfixe des répertoires temporaires (un par export), repéré par la purge
const TMP_PREFIX = 'exp-';

/**
 * Throws the abort reason when the signal has fired.
 *
 * @param signal - Cancellation signal of the export.
 * @throws The abort reason.
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/**
 * Runs a DuckDB step so that an abort interrupts it.
 *
 * The interrupt is only issued while the step is running: interrupting an
 * idle connection is never needed, and the connection goes back to the pool
 * right after.
 *
 * @param ctx - Export context.
 * @param step - DuckDB work to run.
 * @returns The step result.
 * @throws The abort reason when the signal fired during the step.
 */
// Interruption de la requête DuckDB en cours si le signal se déclenche
async function interruptible<T>(ctx: ExportRunContext, step: () => Promise<T>): Promise<T> {
  throwIfAborted(ctx.signal);
  const onAbort = (): void => ctx.connection.conn.interrupt();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await step();
  } catch (error) {
    // Une requête interrompue échoue avec « Interrupted! » : la vraie cause est le signal
    throwIfAborted(ctx.signal);
    throw error;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Prepares a statement and binds its positional parameters.
 *
 * @param connection - Pool connection.
 * @param sql - SQL text with `?` placeholders.
 * @param params - Values bound in order.
 * @returns The bound prepared statement.
 */
async function prepareBound(connection: ConnectionWrapper, sql: string, params: unknown[]) {
  const prepared = await connection.conn.prepare(sql);
  params.forEach((param, i) => bindParam(prepared, param, i + 1));
  return prepared;
}

// ─── csv / parquet : COPY vers fichier temporaire ────────────────────────────

/**
 * Serves a csv or parquet export through a temporary file.
 *
 * The file lives in its own directory under tmpDir, removed in `finally` on
 * every path — success, SQL error, timeout, client abort.
 *
 * @param ctx - Export context.
 * @param format - csv or parquet.
 * @param tmpDir - Root directory of the temporary files.
 * @returns The number of exported rows.
 */
async function runCopyExport(
  ctx: ExportRunContext,
  format: 'csv' | 'parquet',
  tmpDir: string,
): Promise<number> {
  await fs.mkdir(tmpDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmpDir, TMP_PREFIX));
  try {
    const file = path.join(dir, `export.${FORMAT_SPECS[format].extension}`);
    // Chemin en « / » (accepté par DuckDB sur tous les OS) et échappé
    const target = escapeSqlString(file.split(path.sep).join('/'));
    const options = format === 'csv' ? CSV_COPY_OPTIONS : 'FORMAT PARQUET';
    const copySql = `COPY (${ctx.query.sql}) TO '${target}' (${options})`;

    const result: DuckDBMaterializedResult = await interruptible(ctx, async () => {
      const prepared = await prepareBound(ctx.connection, copySql, ctx.query.params);
      return prepared.run();
    });
    throwIfAborted(ctx.signal);

    const rowCount = Number(result.rowsChanged);
    ctx.sendHeaders(rowCount);
    await pipeline(createReadStream(file), ctx.res, { signal: ctx.signal });
    return rowCount;
  } finally {
    // Nouvelles tentatives : sous Windows le descripteur peut se fermer avec retard
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

// ─── arrow : lecture par chunks et flux IPC ──────────────────────────────────

/**
 * Serves an arrow export as an IPC stream built chunk by chunk.
 *
 * Backpressure: after each batch, waits for the response to drain before
 * reading the next chunk, so memory stays bounded by a few chunks. An export
 * without rows still sends its schema (one empty batch).
 *
 * @param ctx - Export context.
 * @returns The number of exported rows.
 */
async function runArrowExport(ctx: ExportRunContext): Promise<number> {
  const result: DuckDBResult = await interruptible(ctx, async () => {
    const prepared = await prepareBound(ctx.connection, ctx.query.sql, ctx.query.params);
    return prepared.stream();
  });
  const layout = buildArrowLayout(result.columnNames(), result.columnTypes());

  ctx.sendHeaders(null);
  const writer = new RecordBatchStreamWriter();
  const sent = pipeline(writer.toNodeStream(), ctx.res, { signal: ctx.signal });
  // Gestionnaire immédiat : un abandon rejette `sent` avant qu'il ne soit attendu
  sent.catch(() => undefined);

  let rowCount = 0;
  try {
    await interruptible(ctx, async () => {
      for await (const chunk of result) {
        if (ctx.signal.aborted) break;
        if (chunk.rowCount === 0) continue;
        writer.write(chunkToRecordBatch(chunk, layout));
        rowCount += chunk.rowCount;
        // Contre-pression : pas de nouveau chunk tant que la réponse n'a pas vidé son tampon
        if (ctx.res.writableNeedDrain) await once(ctx.res, 'drain', { signal: ctx.signal });
      }
    });
    throwIfAborted(ctx.signal);

    if (rowCount === 0) writer.write(emptyRecordBatch(layout));
    writer.close();
    await sent;
    return rowCount;
  } catch (error) {
    // Flux tronqué côté client (pas de marqueur de fin IPC) : c'est le signal d'erreur
    ctx.res.destroy(error as Error);
    await sent.catch(() => undefined);
    throw error;
  }
}

/**
 * Removes the temporary directories left by a crashed process.
 *
 * Only directories older than twice the export timeout are removed: a live
 * export — of this process or of another one sharing tmpDir — is always
 * younger than that.
 *
 * @param tmpDir - Root directory of the temporary files.
 * @param timeoutMs - Export timeout, in milliseconds.
 * @returns The number of directories removed.
 */
// Purge des répertoires orphelins (arrêt brutal pendant un export)
async function purgeStaleExports(tmpDir: string, timeoutMs: number): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(tmpDir);
  } catch {
    return 0;
  }
  const threshold = Date.now() - 2 * timeoutMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
    const dir = path.join(tmpDir, entry);
    try {
      const stat = await fs.stat(dir);
      if (stat.mtimeMs < threshold) {
        await fs.rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Entrée disparue entre-temps : rien à faire
    }
  }
  return removed;
}

export { runArrowExport, runCopyExport, purgeStaleExports, TMP_PREFIX };
export type { ExportRunContext };
