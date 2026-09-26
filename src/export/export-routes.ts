// Route REST d'export volumineux (Arrow / CSV / Parquet), hors sérialisation GraphQL
import type { Express, Request, RequestHandler, Response } from 'express';
import { databaseManager } from '../db/index.js';
import type { ConnectionWrapper, DuckDBPool } from '../db/pool.js';
import { resolveClientIp } from '../security/rate-limiter.js';
import type { HttpRequest } from '../security/rate-limiter.js';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';
import { buildExportQuery, resolveExportTarget } from './build-export-query.js';
import { ExportConcurrencyGate } from './concurrency-gate.js';
import {
  ExportHttpError,
  FORMAT_SPECS,
  loadExportSettings,
  parseExportQuery,
} from './export-params.js';
import type { ExportSettings } from './export-params.js';
import { purgeStaleExports, runArrowExport, runCopyExport } from './export-runner.js';
import type { ExportRunContext } from './export-runner.js';

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
  /** Proxies allowed to forward the client IP; defaults to RATE_LIMIT.TRUSTED_PROXIES. */
  trustedProxies?: ReadonlySet<string>;
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
 * Reads the trusted proxy list of the rate limiter configuration.
 *
 * Accepts both the parsed array and the JSON string form of an environment
 * override (`TRUSTED_PROXIES='["10.0.0.1"]'`).
 *
 * @returns The set of trusted proxy IPs.
 */
// Liste des proxys de confiance, tolérante à la forme chaîne JSON des variables d'env
function configuredTrustedProxies(): ReadonlySet<string> {
  const raw: unknown = config.SECURITY?.RATE_LIMIT?.TRUSTED_PROXIES;
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  return new Set(Array.isArray(list) ? list.map(String) : []);
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
  res.removeHeader('Content-Disposition');
  res.removeHeader('X-Row-Count');

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
 * arrow) and `limit` (capped by EXPORT.MAX_ROWS).
 *
 * Guards, in order: rate limiter (shared with /graphql), parameter validation
 * (400/404/409 before any slot or connection is taken), concurrency gate
 * (429), timeout (interrupt + end of stream). The pool connection and the
 * gate slot are always given back in `finally`, client abort included. No
 * Redis cache: `Cache-Control: no-store`.
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
  const trustedProxies = options.trustedProxies ?? configuredTrustedProxies();

  // Purge des fichiers temporaires laissés par un arrêt brutal (non bloquante)
  void purgeStaleExports(settings.tmpDir, settings.timeoutMs).then((removed) => {
    if (removed > 0) exportLogger.warn('Removed stale export files', { removed });
  });

  const handler = async (req: Request, res: Response): Promise<void> => {
    // Flux volumineux, jamais mis en cache ; en-têtes lisibles par un front CORS
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Row-Count');

    const startedAt = Date.now();
    const controller = new AbortController();
    let releaseSlot: (() => void) | null = null;
    let pool: DuckDBPool | null = null;
    let connection: ConnectionWrapper | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Déconnexion du client avant la fin de l'envoi : interruption de l'export
    const onClose = (): void => {
      if (!res.writableFinished) controller.abort(new ClientAbortError());
    };

    try {
      // 1. Validation complète avant de consommer un créneau ou une connexion
      const params = parseExportQuery(req.query as Record<string, unknown>, settings);
      const target = resolveExportTarget(params);
      const query = await buildExportQuery(params, target);

      // 2. Garde de concurrence (IP seule)
      const clientIp = resolveClientIp(req as unknown as HttpRequest, trustedProxies);
      const slot = gate.tryAcquire(clientIp);
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
      timer = setTimeout(() => {
        controller.abort(
          new ExportHttpError(
            504,
            'Export timed out',
            `The export exceeded ${settings.timeoutMs} ms; narrow it with filters, fields or limit.`,
          ),
        );
      }, settings.timeoutMs);
      res.on('close', onClose);

      // 4. Connexion du pool, rendue en finally
      pool = databaseManager.getPool(target.catalog);
      connection = await pool.acquire();

      const { contentType, extension } = FORMAT_SPECS[params.format];
      const ctx: ExportRunContext = {
        connection,
        query,
        res,
        signal: controller.signal,
        sendHeaders: (rowCount) => {
          res.status(200);
          res.set('Content-Type', contentType);
          res.set(
            'Content-Disposition',
            `attachment; filename="${exportFileName(target.catalog, target.schema, extension)}"`,
          );
          if (rowCount !== null) res.set('X-Row-Count', String(rowCount));
        },
      };

      // Comptage des lignes retournées
      const rowCount =
        params.format === 'arrow'
          ? await runArrowExport(ctx)
          : await runCopyExport(ctx, params.format, settings.tmpDir);

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
      if (pool && connection) pool.release(connection);
      releaseSlot?.();
    }
  };

  if (options.rateLimit) {
    app.get('/api/export', options.rateLimit, handler);
  } else {
    app.get('/api/export', handler);
  }

  return { settings, gate };
};

export { createExportRoutes };
export type { ExportRoutesOptions, ExportRoutesHandle };
