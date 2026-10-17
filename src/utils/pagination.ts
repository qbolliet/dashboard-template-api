// Importation des modules
import { GraphQLError } from 'graphql';
import { config } from './config-loader.js';

/**
 * Builds a GraphQL error flagged as a client input error.
 *
 * @param message - Human-readable error message.
 * @returns GraphQLError with the BAD_USER_INPUT extension code.
 */
const badInput = (message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * Validates pagination arguments against the configured bounds.
 *
 * Called by every paginated resolver before any loader: `limit` must be at
 * least 1 (a zero limit would make `currentPage` infinite) and at most
 * MAX_LIMIT, `offset` at least 0 and at most MAX_OFFSET.
 *
 * @param limit - Maximum number of rows (or groups, or options) to return.
 * @param offset - Number of rows to skip; 0 for queries without offset.
 * @throws {GraphQLError} BAD_USER_INPUT when a bound is violated.
 */
// Validation des bornes de pagination
function validatePagination(limit: number, offset: number = 0): void {
  const { MAX_LIMIT, MAX_OFFSET } = config.API.PAGINATION;
  if (!Number.isInteger(limit) || limit < 1) {
    throw badInput(`Limit must be a positive integer, got ${String(limit)}.`);
  }
  if (limit > MAX_LIMIT) {
    throw badInput(`Limit cannot exceed ${MAX_LIMIT}, got ${limit}.`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw badInput(`Offset must be a non-negative integer, got ${String(offset)}.`);
  }
  if (offset > MAX_OFFSET) {
    throw badInput(`Offset cannot exceed ${MAX_OFFSET}, got ${offset}.`);
  }
}

export { validatePagination };
