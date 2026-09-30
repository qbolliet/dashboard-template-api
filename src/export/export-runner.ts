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
import { runInterruptible } from '../db/interrupt.js';
import type { ConnectionWrapper } from '../db/pool.js';
import { buildArrowLayout, chunkToRecordBatch, emptyRecordBatch } from './arrow-writer.js';
import { encodeCursor } from './after-cursor.js';
import { embeddedMetadata } from './embedded-metadata.js';
import { ExportHttpError, FORMAT_SPECS } from './export-params.js';
import type { ParquetCompression } from './export-params.js';
import type { ExportQuery } from './build-export-query.js';

// ─── Contexte d'exécution ────────────────────────────────────────────────────

/**
 * Execution of an export on a pool connection.
 *
 * Choices:
 * - csv / parquet: `COPY (SELECT …) TO '<tmp file>'` — DuckDB writes natively
 *   (parallel, types preserved), `rowsChanged` gives the exact row count for
 *   free, and the file is then streamed to the response. Writing a local file
 *   is allowed: only the catalog is read-only, not the in-memory instance.
 *   The pool connection is given back as soon as the COPY is done — the
 *   transfer of a big file to a slow client no longer holds it — and the
 *   file size becomes the exact `Content-Length`. Parquet embeds the column
 *   metadata and the dataset description (`KV_METADATA`).
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
  /**
   * Sends the response headers; rowCount is null when unknown before streaming,
   * contentLength is given when the body is a file of known size. Marks the
   * start of the transfer, whose budget differs from the query's.
   */
  sendHeaders: (rowCount: number | null, contentLength?: number) => void;
  /**
   * Gives the pool connection back; idempotent. The runner calls it as soon as
   * it no longer needs DuckDB, and never uses `connection` afterwards.
   */
  releaseConnection: () => void;
}

/** Format options of a csv / parquet export. */
interface CopyOptions {
  /** csv: prefix the file with a UTF-8 byte order mark. */
  bom?: boolean;
  /** parquet: compression codec (snappy by default). */
  compression?: ParquetCompression;
}

// Marque d'ordre des octets UTF-8 : Excel sous Windows s'en sert pour décoder les accents
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

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
 * Runs a DuckDB step so that an abort of the export interrupts it
 * (see runInterruptible, shared with the loaders).
 *
 * @param ctx - Export context.
 * @param step - DuckDB work to run.
 * @returns The step result.
 * @throws The abort reason when the signal fired during the step.
 */
// Interruption de la requête DuckDB en cours si le signal se déclenche
function interruptible<T>(ctx: ExportRunContext, step: () => Promise<T>): Promise<T> {
  return runInterruptible(ctx.connection, ctx.signal, step);
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

// ─── Sonde : total et curseur, avant le premier octet ────────────────────────

/** What the export must announce before its body. */
interface ExportProbe {
  /** Rows matching the request, `limit` aside (after the cursor if any). */
  total: number;
  /** Cursor of the last row sent when the export is truncated, else null. */
  nextAfter: string | null;
}

/**
 * Counts the rows of an export and, when they exceed the limit, reads the key
 * of the last row that will be sent.
 *
 * One mechanism for every format, run before any header: a COPY cannot stop
 * one row short of what it wrote, and an Arrow stream has sent its headers
 * long before knowing it hit its LIMIT. The count reads the filter and key
 * columns only, without sorting; the boundary query, run only on a truncated
 * page that will be sent, top-n sorts the key columns.
 *
 * @param ctx - Export context.
 * @param limit - Effective row ceiling of the request.
 * @param withCursor - Whether a truncated export will be sent (explicit
 *   `limit`); without it, the export is refused and needs no cursor.
 * @returns The total and, on a truncated page to send, the resume cursor.
 */
async function probeExport(
  ctx: ExportRunContext,
  limit: number,
  withCursor: boolean,
): Promise<ExportProbe> {
  // Comptage et borne
  const { count, boundary, order } = ctx.query;
  const total = await interruptible(ctx, async () => {
    const prepared = await prepareBound(ctx.connection, count.sql, count.params);
    const rows = (await prepared.runAndReadAll()).getRows();
    return Number(rows[0][0]);
  });
  throwIfAborted(ctx.signal);
  if (total <= limit || !withCursor) return { total, nextAfter: null };

  // Requête SQL et paramètres
  const { sql, params } = boundary(limit - 1);
  const key = await interruptible(ctx, async () => {
    const prepared = await prepareBound(ctx.connection, sql, params);
    return (await prepared.runAndReadAll()).getRows()[0];
  });
  throwIfAborted(ctx.signal);
  // Ligne comptée mais introuvable : le catalogue a changé entre les deux requêtes
  if (!key) throw new Error('The export boundary row vanished between the count and the key query');

  const values = key.map((value) => (value === null ? null : String(value)));
  return { total, nextAfter: encodeCursor(order, values) };
}

// ─── csv / parquet : COPY vers fichier temporaire ────────────────────────────

/**
 * Serves a csv or parquet export through a temporary file.
 *
 * The file lives in its own directory under tmpDir, removed in `finally` on
 * every path — success, SQL error, timeout, client abort. The pool connection
 * is released right after the COPY, before the first byte is sent.
 *
 * @param ctx - Export context.
 * @param format - csv or parquet.
 * @param tmpDir - Root directory of the temporary files.
 * @param options - Format options (BOM, parquet compression).
 * @returns The number of exported rows.
 */
async function runCopyExport(
  ctx: ExportRunContext,
  format: 'csv' | 'parquet',
  tmpDir: string,
  options: CopyOptions = {},
): Promise<number> {
  await fs.mkdir(tmpDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmpDir, TMP_PREFIX));
  try {
    const file = path.join(dir, `export.${FORMAT_SPECS[format].extension}`);
    // Chemin en « / » (accepté par DuckDB sur tous les OS) et échappé
    const target = escapeSqlString(file.split(path.sep).join('/'));
    const copyOptions =
      format === 'csv' ? CSV_COPY_OPTIONS : parquetCopyOptions(ctx.query, options.compression);
    const copySql = `COPY (${ctx.query.sql}) TO '${target}' (${copyOptions})`;

    const result: DuckDBMaterializedResult = await interruptible(ctx, async () => {
      const prepared = await prepareBound(ctx.connection, copySql, ctx.query.params);
      return prepared.run();
    });
    // DuckDB n'est plus sollicité : le transfert, lent ou non, ne retient pas la connexion
    ctx.releaseConnection();
    throwIfAborted(ctx.signal);

    const rowCount = Number(result.rowsChanged);
    const bom = format === 'csv' && options.bom === true;
    const { size } = await fs.stat(file);
    ctx.sendHeaders(rowCount, size + (bom ? UTF8_BOM.length : 0));
    if (bom) ctx.res.write(UTF8_BOM);
    await pipeline(createReadStream(file), ctx.res, { signal: ctx.signal });
    return rowCount;
  } finally {
    // Nouvelles tentatives : sous Windows le descripteur peut se fermer avec retard
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/**
 * Builds the option list of a parquet COPY: codec and embedded metadata.
 *
 * The metadata travels as `KV_METADATA` string literals (`database.metadata`,
 * `database.dataset`): they hold no bound value, so they are escaped and
 * inlined after the query, whose positional parameters stay in order.
 *
 * @param query - Export query, carrying the description to embed.
 * @param compression - Codec, snappy by default.
 * @returns The text between the parentheses of the COPY options.
 */
function parquetCopyOptions(
  query: ExportQuery,
  compression: ParquetCompression = 'snappy',
): string {
  const pairs = Object.entries(embeddedMetadata(query.description))
    .map(([key, value]) => `'${escapeSqlString(key)}': '${escapeSqlString(value)}'`)
    .join(', ');
  return `FORMAT PARQUET, COMPRESSION ${compression}, KV_METADATA {${pairs}}`;
}

/**
 * Refuses a csv/parquet export when the temporary volume is nearly full.
 *
 * The COPY writes the whole file before the first byte, so a full disk would
 * fail mid-COPY with a DuckDB I/O error. The check is a floor on free space,
 * not a reservation: the size of the file is unknown before the COPY. A
 * volume whose free space cannot be read (statfs unsupported) lets the export
 * through: the guard degrades, the export does not.
 *
 * @param tmpDir - Root directory of the temporary files.
 * @param minFreeMb - Free space to preserve, in MB; 0 disables the check.
 * @throws {ExportHttpError} 507 when the free space is below the threshold.
 */
async function assertTmpSpace(tmpDir: string, minFreeMb: number): Promise<void> {
  if (minFreeMb <= 0) return;
  await fs.mkdir(tmpDir, { recursive: true });
  let stats: Awaited<ReturnType<typeof fs.statfs>>;
  try {
    stats = await fs.statfs(tmpDir);
  } catch {
    return;
  }
  const freeMb = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
  if (freeMb < minFreeMb) {
    throw new ExportHttpError(
      507,
      'Insufficient storage',
      `The export directory has ${freeMb} MB free, below the ${minFreeMb} MB required ` +
        '(EXPORT.TMP_MIN_FREE_MB). Retry later, or use format=arrow, which needs no temporary file.',
    );
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
  const layout = buildArrowLayout(
    result.columnNames(),
    result.columnTypes(),
    ctx.query.description,
  );

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

export {
  assertTmpSpace,
  probeExport,
  runArrowExport,
  runCopyExport,
  purgeStaleExports,
  TMP_PREFIX,
};
export type { CopyOptions, ExportProbe, ExportRunContext };
