// Importation des modules
import express from 'express';
import type { Application, ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { config } from '../utils/config-loader.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Size limits applied to incoming HTTP request bodies (API.REQUEST_LIMITS). */
interface RequestLimits {
  /** Maximum size of the raw body, in the format accepted by body-parser (« 100kb »). */
  MAX_REQUEST_SIZE: string;
  /** Maximum length of the GraphQL document (`query`), in characters. */
  MAX_QUERY_SIZE: number;
}

/** Error raised by body-parser, carrying its machine-readable type. */
interface BodyParserError extends Error {
  type?: string;
}

// ─── Réponse d'erreur ────────────────────────────────────────────────────────

/**
 * Sends a 400 response in the GraphQL error shape.
 *
 * A rejected size is a malformed request, not an authorization failure: the
 * status is 400 (never 403) and the body names the limit that was exceeded.
 *
 * @param res - Express response.
 * @param code - Machine-readable error code.
 * @param message - Human-readable explanation of the limit exceeded.
 */
const sendBadRequest = (res: Response, code: string, message: string): void => {
  res.status(400).json({ errors: [{ message, extensions: { code } }] });
};

// ─── Contrôle de la taille du document ───────────────────────────────────────

/**
 * Builds the middleware that bounds the GraphQL document.
 *
 * Runs after express.json, on the parsed body: `query` is bounded by its own
 * dedicated size (MAX_QUERY_SIZE). `variables` are not bounded value by value:
 * filter values are bound parameters, the structure of a filter tree is bounded
 * by SECURITY.FILTER_TREE and the whole body by MAX_REQUEST_SIZE. Messages
 * echoing a value truncate it (see previewValue).
 *
 * @param limits - Size limits to enforce.
 * @returns Express middleware replying 400 on an oversized document.
 */
const createRequestSizeGuard =
  (limits: RequestLimits) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const body: unknown = req.body;
    // Un lot de requêtes est un tableau : chaque élément est contrôlé
    const operations = Array.isArray(body) ? body : [body];

    // Parcours des opérations
    for (const operation of operations) {
      if (typeof operation !== 'object' || operation === null) continue;
      // Extraction du document GraphQL
      const { query } = operation as { query?: unknown };

      // Vérification de l'opération
      if (typeof query === 'string' && query.length > limits.MAX_QUERY_SIZE) {
        sendBadRequest(
          res,
          'QUERY_TOO_LARGE',
          `GraphQL document exceeds the maximum size of ${limits.MAX_QUERY_SIZE} characters.`,
        );
        return;
      }
    }
    next();
  };

/**
 * Builds the error handler turning body-parser's size rejection into a 400.
 *
 * body-parser answers 413 by default; the API contract is a 400 with an
 * explicit JSON body. Any other error is left to the following handlers.
 *
 * @param limits - Size limits, used to name the ceiling in the message.
 * @returns Express error handler.
 */
const createBodyTooLargeHandler =
  (limits: RequestLimits): ErrorRequestHandler =>
  (err: BodyParserError, _req: Request, res: Response, next: NextFunction): void => {
    if (err.type !== 'entity.too.large') {
      next(err);
      return;
    }
    sendBadRequest(
      res,
      'REQUEST_BODY_TOO_LARGE',
      `Request body exceeds the maximum size of ${limits.MAX_REQUEST_SIZE}.`,
    );
  };

// ─── Branchement ─────────────────────────────────────────────────────────────

/**
 * Mounts the JSON body parser and its size guards on an Express application.
 *
 * Order matters: the parser enforces MAX_REQUEST_SIZE, the handler maps its
 * rejection to a 400, then the guard bounds `query`.
 *
 * @param app - Express application to configure.
 * @param limits - Size limits; defaults to API.REQUEST_LIMITS.
 */
const applyRequestLimits = (
  app: Application,
  limits: RequestLimits = config.API.REQUEST_LIMITS,
): void => {
  app.use(
    express.json({ limit: limits.MAX_REQUEST_SIZE }),
    createBodyTooLargeHandler(limits),
    createRequestSizeGuard(limits),
  );
};

export { applyRequestLimits, createRequestSizeGuard, createBodyTooLargeHandler };
export type { RequestLimits };
