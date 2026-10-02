// Route REST d'export volumineux (Arrow / CSV / Parquet), hors sérialisation GraphQL
import express from 'express';
import type { ErrorRequestHandler, Express, Request, RequestHandler, Response } from 'express';
import { databaseManager } from '../db/index.js';
import type { ConnectionWrapper, DuckDBPool } from '../db/pool.js';
import { clientIp } from '../security/rate-limiter.js';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';
import { buildExportQuery, resolveExportTarget } from './build-export-query.js';
import { ExportConcurrencyGate } from './concurrency-gate.js';
import {
  ExportHttpError,
  FORMAT_SPECS,
  loadExportSettings,
  parseExportParams,
} from './export-params.js';
import type { ExportParams, ExportSettings } from './export-params.js';
import {
  assertTmpSpace,
  probeExport,
  purgeStaleExports,
  runArrowExport,
  runCopyExport,
} from './export-runner.js';
import type { ExportProbe, ExportRunContext } from './export-runner.js';

// Logger spécifique au module d'export
const exportLogger = createContextLogger({ component: 'export', module: 'export-routes' });

// ─── Options ─────────────────────────────────────────────────────────────────

/** Injectable dependencies of the export route (tests, server wiring). */
interface ExportRoutesOptions {
  /** Rate-limit middleware placed before the handler (shared budget with /graphql). */
  rateLimit?: RequestHandler;
  /** Guards; defaults to the EXPORT section of config/api.yaml. */
  settings?: ExportSettings;
  /** Concurrency gate; defaults to one built from the settings. */
  gate?: ExportConcurrencyGate;
}

/** Handles returned to the caller, for diagnostics and tests. */
interface ExportRoutesHandle {
  settings: ExportSettings;
  gate: ExportConcurrencyGate;
}

/** Abort reason when the client closes the connection mid-export. */
class ClientAbortError extends Error {
  constructor() {
    super('Client closed the connection');
    this.name = 'ClientAbortError';
  }
}

/**
 * Builds the attachment file name of an export.
 *
 * @param catalog - Catalog alias.
 * @param schema - Schema name.
 * @param extension - File extension of the format.
 * @returns `<catalog>_<schema>_<YYYY-MM-DD>.<ext>` (UTC date).
 */
const exportFileName = (catalog: string, schema: string, extension: string): string =>
  `${catalog}_${schema}_${new Date().toISOString().slice(0, 10)}.${extension}`;

// En-têtes propres à un fichier servi, retirés quand la réponse devient une erreur
const FILE_HEADERS = [
  'Content-Disposition',
  'X-Row-Count',
  'X-Total-Count',
  'X-Truncated',
  'X-Next-After',
];

// Content-Length est un en-tête de fichier aussi, mais déjà lisible en CORS
const RESET_HEADERS = [...FILE_HEADERS, 'Content-Length'];

// ─── Paramètres : query string (GET) ou corps JSON (POST) ────────────────────

/**
 * Reads the parameters of an export from its transport.
 *
 * GET: the query string. POST: the JSON body, for filters too large for a URL
 * (the header limit of Node, lower still behind an ingress); its query string
 * must then be empty, so that no parameter is silently ignored.
 *
 * @param req - Express request.
 * @param settings - Export guards (row ceiling).
 * @returns The validated parameters.
 * @throws {ExportHttpError} 415 for a POST body that is not JSON, 400 for an
 *   invalid body or parameter.
 */
function readExportParams(req: Request, settings: ExportSettings): ExportParams {
  if (req.method !== 'POST') {
    return parseExportParams(req.query as Record<string, unknown>, settings, 'query');
  }
  if (!req.is('application/json')) {
    throw new ExportHttpError(
      415,
      'Unsupported media type',
      'POST /api/export expects a JSON body (Content-Type: application/json).',
    );
  }
  if (Object.keys(req.query).length > 0) {
    throw new ExportHttpError(
      400,
      'Invalid export parameter',
      'POST /api/export takes its parameters in the JSON body only, not in the query string.',
    );
  }
  const body: unknown = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ExportHttpError(
      400,
      'Invalid export parameter',
      'The body of POST /api/export must be a JSON object of export parameters.',
    );
  }
  return parseExportParams(body as Record<string, unknown>, settings, 'body');
}

/**
 * Maps a failure of the JSON body parser to the export error format.
 *
 * Only reached when the route mounts its own parser (no global one ran
 * before, as in a test application); the global parser of /graphql answers
 * in its own format otherwise.
 *
 * @param maxSize - Body size limit, quoted in the message.
 * @returns The Express error middleware.
 */
const createBodyErrorHandler =
  (maxSize: string): ErrorRequestHandler =>
  (err: { type?: string }, _req, res, _next) => {
    res.set('Cache-Control', 'no-store');
    res.status(400).json({
      error: 'Invalid export parameter',
      detail:
        err.type === 'entity.too.large'
          ? `Request body exceeds the maximum size of ${maxSize}.`
          : 'The request body is not valid JSON.',
    });
  };

// ─── Réponse d'erreur ────────────────────────────────────────────────────────

/**
 * Reports an export failure to the client.
 *
 * Before the first byte, a JSON body `{error, detail}` with the proper status;
 * once the body has started, the connection is destroyed — a truncated file
 * (no Arrow end-of-stream, short csv/parquet) is the only possible signal.
 *
 * @param res - Express response.
 * @param error - The failure.
 */
function sendExportError(res: Response, error: unknown): void {
  // Client parti : plus personne à qui répondre
  if (error instanceof ClientAbortError) return;

  if (res.headersSent) {
    if (!res.destroyed) res.destroy();
    return;
  }

  // En-têtes de fichier posés avant l'échec : la réponse devient un JSON d'erreur
  RESET_HEADERS.forEach((name) => res.removeHeader(name));

  if (error instanceof ExportHttpError) {
    res.status(error.status).json({ error: error.error, detail: error.detail });
    return;
  }

  // Message en cas d'erreur d'acquisition de la connexion
  const message = (error as Error)?.message ?? String(error);
  if (message.includes('Connection acquisition timeout')) {
    res.status(503).json({ error: 'Database busy', detail: 'No database connection available.' });
    return;
  }

  const isProduction = config.ENVIRONMENT === 'production';
  res.status(500).json({
    error: 'Export failed',
    detail: isProduction ? 'Internal server error' : message,
  });
}

// ─── Route ───────────────────────────────────────────────────────────────────

/**
 * Registers the export route on an Express application.
 *
 * `GET /api/export` streams the fact table of a catalog/schema as an Arrow IPC
 * stream, a CSV file or a Parquet file, bypassing the GraphQL JSON
 * serialization. Parameters: `catalog`, `schema`, `fields` (comma-separated),
 * `filters` (URL-encoded JSON of a FilterNode), `sort` (`col:asc,col2:desc`,
 * default: the schema's cluster_by), `format` (arrow | csv | parquet, default
 * arrow), `limit` (capped by EXPORT.MAX_ROWS) and `after` (resume cursor).
 * With `aggregates` (`measure[:aggregation[:alias]]`, comma-separated) and
 * optionally `groupBy` (`field[:grain]`), the export sends the rows of
 * getAggregates instead of the fact rows.
 * `POST /api/export` takes the same parameters as a JSON body, for filters
 * too large for a URL; same handler, same guards.
 *
 * Before the first byte, a count gives `X-Total-Count`. Beyond the limit, the
 * export is refused with a 413 when the client gave no `limit` (MAX_ROWS
 * would cut it silently), and sent truncated otherwise, with `X-Truncated`
 * and `X-Next-After`, the cursor of the next page.
 *
 * Guards, in order: rate limiter (shared with /graphql), parameter validation
 * (400/404/409/415 before any slot or connection is taken), free space of the
 * temporary volume for csv/parquet (507), concurrency gate (429), timeouts
 * (interrupt + end of stream): TIMEOUT_MS until the first byte,
 * TRANSFER_TIMEOUT_MS from the first byte to the end. The pool connection and
 * the gate slot are always given back in `finally`, client abort included; a
 * csv/parquet export gives its connection back as soon as the file is written,
 * before the transfer. No Redis cache: `Cache-Control: no-store`.
 *
 * @param app - Express application instance to register the route on.
 * @param options - Injectable dependencies.
 * @returns The effective settings and gate.
 */
const createExportRoutes = (
  app: Express,
  options: ExportRoutesOptions = {},
): ExportRoutesHandle => {
  const settings = options.settings ?? loadExportSettings();
  const gate =
    options.gate ??
    new ExportConcurrencyGate(settings.maxConcurrentPerIp, settings.maxConcurrentTotal);

  // Purge des fichiers temporaires laissés par un arrêt brutal (non bloquante) ;
  // un export vivant a au plus timeoutMs + transferTimeoutMs
  void purgeStaleExports(settings.tmpDir, settings.timeoutMs + settings.transferTimeoutMs).then(
    (removed) => {
      if (removed > 0) exportLogger.warn('Removed stale export files', { removed });
    },
  );

  const handler = async (req: Request, res: Response): Promise<void> => {
    // Flux volumineux, jamais mis en cache ; en-têtes lisibles par un front CORS
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Expose-Headers', FILE_HEADERS.join(', '));

    const startedAt = Date.now();
    const controller = new AbortController();
    let releaseSlot: (() => void) | null = null;
    let pool: DuckDBPool | null = null;
    let connection: ConnectionWrapper | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let connectionReleased = false;

    // Rendu unique de la connexion : par le runner dès qu'il n'a plus besoin de DuckDB, sinon en finally
    const releaseConnection = (): void => {
      if (connectionReleased || !pool || !connection) return;
      connectionReleased = true;
      pool.release(connection);
    };

    // Un seul minuteur à la fois : requête, puis envoi
    const armTimer = (ms: number, error: ExportHttpError): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(error), ms);
    };

    // Déconnexion du client avant la fin de l'envoi : interruption de l'export
    const onClose = (): void => {
      if (!res.writableFinished) controller.abort(new ClientAbortError());
    };

    try {
      // 1. Validation complète avant de consommer un créneau ou une connexion
      const params = readExportParams(req, settings);
      const target = resolveExportTarget(params);
      const query = await buildExportQuery(params, target);
      // Le COPY écrit le fichier entier avant le premier octet : volume plein = refus net
      if (params.format !== 'arrow') {
        await assertTmpSpace(settings.tmpDir, settings.tmpMinFreeMb);
      }

      // 2. Garde de concurrence (IP seule, résolue par Express via trust proxy)
      const slot = gate.tryAcquire(clientIp(req));
      if (!slot.ok) {
        throw new ExportHttpError(
          429,
          'Too many concurrent exports',
          slot.reason === 'client'
            ? `At most ${settings.maxConcurrentPerIp} concurrent export(s) per client; retry once one has finished.`
            : `The server is running its maximum of ${settings.maxConcurrentTotal} concurrent export(s); retry later.`,
        );
      }
      releaseSlot = slot.release;

      // 3. Minuteur et abandon client, armés dès que des ressources sont engagées
      armTimer(
        settings.timeoutMs,
        new ExportHttpError(
          504,
          'Export timed out',
          `The export exceeded ${settings.timeoutMs} ms; narrow it with filters, fields or limit.`,
        ),
      );
      res.on('close', onClose);

      // 4. Connexion du pool, rendue en finally
      pool = databaseManager.getPool(target.catalog);
      connection = await pool.acquire();

      const { contentType, extension } = FORMAT_SPECS[params.format];
      let probe: ExportProbe = { total: 0, nextAfter: null };
      const ctx: ExportRunContext = {
        connection,
        query,
        res,
        signal: controller.signal,
        releaseConnection,
        sendHeaders: (rowCount, contentLength) => {
          // Premier octet : le budget de la requête cède la place à celui de l'envoi
          armTimer(
            settings.transferTimeoutMs,
            new ExportHttpError(
              504,
              'Export transfer timed out',
              `The transfer exceeded ${settings.transferTimeoutMs} ms; the client reads too slowly.`,
            ),
          );
          res.status(200);
          res.set('Content-Type', contentType);
          res.set(
            'Content-Disposition',
            `attachment; filename="${exportFileName(target.catalog, target.schema, extension)}"`,
          );
          // Arrow : nombre de lignes déduit de la sonde, le flux ne le connaît qu'à la fin
          res.set('X-Row-Count', String(rowCount ?? Math.min(probe.total, params.limit)));
          res.set('X-Total-Count', String(probe.total));
          if (contentLength !== undefined) res.set('Content-Length', String(contentLength));
          if (probe.nextAfter !== null) {
            res.set('X-Truncated', 'true');
            res.set('X-Next-After', probe.nextAfter);
          }
        },
      };

      // 5. Sonde avant le premier octet : total, troncature et curseur de reprise
      probe = await probeExport(ctx, params.limit, params.explicitLimit);
      if (probe.total > params.limit && !params.explicitLimit) {
        throw new ExportHttpError(
          413,
          'Export too large',
          `The export matches ${probe.total} rows, above the ceiling of ${settings.maxRows} ` +
            '(EXPORT.MAX_ROWS). Narrow it with filters, or pass "limit" to receive the first rows ' +
            'with an X-Next-After header, then pass its value as "after" to fetch the next page.',
        );
      }

      // Comptage des lignes retournées
      const rowCount =
        params.format === 'arrow'
          ? await runArrowExport(ctx)
          : await runCopyExport(ctx, params.format, settings.tmpDir, {
              bom: params.bom,
              compression: params.compression,
            });

      exportLogger.operation('Export completed', {
        catalog: target.catalog,
        schema: target.schema,
        format: params.format,
        rowCount,
        duration: Date.now() - startedAt,
      });
    } catch (error) {
      if (!(error instanceof ExportHttpError) && !(error instanceof ClientAbortError)) {
        exportLogger.error('Export failed', error, { duration: Date.now() - startedAt });
      } else if (error instanceof ExportHttpError && error.status === 504) {
        exportLogger.warn('Export timed out', { duration: Date.now() - startedAt });
      }
      sendExportError(res, error);
    } finally {
      // Libération systématique : minuteur, écouteur, connexion, créneau
      if (timer) clearTimeout(timer);
      res.off('close', onClose);
      releaseConnection();
      releaseSlot?.();
    }
  };

  // Corps JSON du POST : même plafond que /graphql ; sans effet quand le
  // parseur global de applyRequestLimits a déjà lu le corps
  const maxBodySize = config.API.REQUEST_LIMITS.MAX_REQUEST_SIZE;
  const guards = options.rateLimit ? [options.rateLimit] : [];
  app.get('/api/export', ...guards, handler);
  app.post(
    '/api/export',
    ...guards,
    express.json({ limit: maxBodySize }),
    createBodyErrorHandler(maxBodySize),
    handler,
  );

  return { settings, gate };
};

export { createExportRoutes };
export type { ExportRoutesOptions, ExportRoutesHandle };
