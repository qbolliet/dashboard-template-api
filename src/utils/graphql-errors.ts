// Importation des types GraphQL
import type { GraphQLFormattedError } from 'graphql';
import type { ContextLogger } from './logger.js';

// ─── Codes d'erreur publics ──────────────────────────────────────────────────

/**
 * Error codes whose message is written for the client and kept in production.
 *
 * They describe a problem with the request itself (invalid input, unknown
 * column, over-budget query, unsupported schema version…) and never carry
 * internal details. Any other code — INTERNAL_SERVER_ERROR first, and any
 * code not listed here — has its message masked in production.
 */
const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set([
  // Codes d'Apollo Server décrivant une requête invalide
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_USER_INPUT',
  'BAD_REQUEST',
  'OPERATION_RESOLUTION_FAILURE',
  'PERSISTED_QUERY_NOT_FOUND',
  'PERSISTED_QUERY_NOT_SUPPORTED',
  // Codes propres à l'API
  'QUERY_COMPLEXITY_EXCEEDED',
  'DEPTH_LIMIT_EXCEEDED',
  'OPERATION_TYPE_NOT_ALLOWED',
  'SCHEMA_VERSION_UNSUPPORTED',
  'CROSS_DATABASE_DISABLED',
]);

// Message renvoyé à la place d'un message interne en production
const MASKED_MESSAGE = 'An error occurred';

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/**
 * Reads the error code of an error's extensions.
 *
 * @param extensions - Extensions of a GraphQL error.
 * @returns The code, INTERNAL_SERVER_ERROR when absent.
 */
function errorCodeOf(extensions: Readonly<Record<string, unknown>> | undefined): string {
  const code = extensions?.['code'];
  return typeof code === 'string' ? code : 'INTERNAL_SERVER_ERROR';
}

/**
 * Tells whether an error code carries a client-facing message.
 *
 * @param code - Error code.
 * @returns True when the message may be sent as is in production.
 */
function isPublicErrorCode(code: string): boolean {
  return PUBLIC_ERROR_CODES.has(code);
}

/**
 * Formats a GraphQL error for the response.
 *
 * Client errors (see {@link PUBLIC_ERROR_CODES}) keep their message,
 * locations, path and extensions in every environment. Other errors keep
 * them in development only; in production the message is replaced by a
 * generic one and only `code` and `errorId` are sent. `errorId` is always
 * present, to be quoted when reporting a problem; the stack trace never is.
 *
 * @param formatted - Error formatted by Apollo Server.
 * @param options - Identifier of the error and environment.
 * @returns The error sent to the client.
 */
function formatGraphQLError(
  formatted: GraphQLFormattedError,
  { errorId, production }: { errorId: string; production: boolean },
): GraphQLFormattedError {
  const code = errorCodeOf(formatted.extensions);

  // Erreur interne en production : ni message ni détail
  if (production && !isPublicErrorCode(code)) {
    return { message: MASKED_MESSAGE, extensions: { code, errorId } };
  }

  // Pile d'appels retirée : elle n'est jamais destinée au client
  const extensions: Record<string, unknown> = { ...formatted.extensions };
  delete extensions['stacktrace'];

  return {
    message: formatted.message,
    ...(formatted.locations ? { locations: formatted.locations } : {}),
    ...(formatted.path ? { path: formatted.path } : {}),
    extensions: { ...extensions, code, errorId },
  };
}

/**
 * Logs a GraphQL error once, under its identifier.
 *
 * A client error is logged as a warning, without stack trace (it is not an
 * incident of the API); any other error as an error, with the stack trace of
 * its original cause.
 *
 * @param log - Logger of the request.
 * @param error - Error raised while processing the request.
 * @param errorId - Identifier sent to the client with the error.
 */
function logGraphQLError(log: ContextLogger, error: unknown, errorId: string): void {
  const graphqlError = error as {
    message?: string;
    path?: readonly (string | number)[];
    extensions?: Record<string, unknown>;
    originalError?: Error;
    stack?: string;
  };
  const code = errorCodeOf(graphqlError.extensions);
  const details = { errorId, code, path: graphqlError.path };

  if (isPublicErrorCode(code)) {
    log.warn(`GraphQL client error: ${graphqlError.message}`, details);
  } else {
    log.error(`GraphQL error: ${graphqlError.message}`, error, {
      ...details,
      stack: graphqlError.originalError?.stack ?? graphqlError.stack,
    });
  }
}

export { PUBLIC_ERROR_CODES, errorCodeOf, isPublicErrorCode, formatGraphQLError, logGraphQLError };
