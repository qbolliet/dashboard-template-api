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
  /** Maximum length of a single string value inside `variables`, in characters. */
  MAX_FIELD_SIZE: number;
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

// ─── Contrôle de la taille des valeurs ───────────────────────────────────────

/**
 * Finds the first string longer than the given length inside a JSON value.
 *
 * The walk is iterative: the depth of a filter tree is bounded elsewhere
 * (SECURITY.FILTER_TREE), but this guard runs before any of those checks.
 *
 * @param root - Parsed JSON value to inspect.
 * @param maxLength - Maximum allowed length for a string value.
 * @returns The key of the offending value, or undefined when all fit.
 */
const findOversizedString = (root: unknown, maxLength: number): string | undefined => {
  // Initialisation de la liste
  const stack: Array<{ key: string; value: unknown }> = [{ key: 'variables', value: root }];

  // Parcours de la liste
  while (stack.length > 0) {
    // Extraction d'un couple "clé-valeur"
    const { key, value } = stack.pop() as { key: string; value: unknown };
    // Vérification de la longueur d'une chaine de caractères
    if (typeof value === 'string') {
      if (value.length > maxLength) {
        return key;
      }
      // Ajout des couples "clé-valeur" d'un objet à la liste à parcourir
    } else if (typeof value === 'object' && value !== null) {
      for (const [childKey, child] of Object.entries(value)) {
        stack.push({ key: childKey, value: child });
      }
    }
  }
  return undefined;
};

/**
 * Builds the middleware that bounds the GraphQL document and its variables.
 *
 * Runs after express.json, on the parsed body: `query` is bounded by its own
 * dedicated size (MAX_QUERY_SIZE) and string values of `variables` by
 * MAX_FIELD_SIZE. The number of keys is deliberately not limited: a filter
 * tree of a few criteria already has dozens of JSON fields, and its size is
 * bounded by SECURITY.FILTER_TREE and by MAX_REQUEST_SIZE.
 *
 * @param limits - Size limits to enforce.
 * @returns Express middleware replying 400 on an oversized document or value.
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
      // Extraction de l'opération et de la variable concernée
      const { query, variables } = operation as { query?: unknown; variables?: unknown };

      // Vérification de l'opération
      if (typeof query === 'string' && query.length > limits.MAX_QUERY_SIZE) {
        sendBadRequest(
          res,
          'QUERY_TOO_LARGE',
          `GraphQL document exceeds the maximum size of ${limits.MAX_QUERY_SIZE} characters.`,
        );
        return;
      }

      // Vérification de la taille de la variable
      const oversized = findOversizedString(variables, limits.MAX_FIELD_SIZE);
      if (oversized !== undefined) {
        sendBadRequest(
          res,
          'VARIABLE_TOO_LARGE',
          `Variable value "${oversized}" exceeds the maximum size of ${limits.MAX_FIELD_SIZE} characters.`,
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
 * rejection to a 400, then the guard bounds `query` and `variables`.
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
