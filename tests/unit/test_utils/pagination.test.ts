/**
 * Unit tests for validatePagination (src/utils/pagination.ts).
 *
 * Every paginated resolver calls it before any loader: out-of-bounds values
 * must be BAD_USER_INPUT errors, never reach DuckDB, and never come back as
 * a silent null. Bounds come from config/api.yaml (MAX_LIMIT 1000,
 * MAX_OFFSET 10000).
 */

import { GraphQLError } from 'graphql';
import { validatePagination } from '../../../src/utils/pagination.js';
import { config } from '../../../src/utils/config-loader.js';

const { MAX_LIMIT, MAX_OFFSET } = config.API.PAGINATION;

/**
 * Returns the error thrown by validatePagination, if any.
 *
 * @param limit - Limit to validate.
 * @param offset - Offset to validate.
 * @returns The thrown error, or undefined.
 */
const failureOf = (limit: number, offset?: number): GraphQLError | undefined => {
  try {
    validatePagination(limit, offset);
    return undefined;
  } catch (error) {
    return error as GraphQLError;
  }
};

describe('validatePagination', () => {
  test.each([
    [0, 0, 'Limit must be a positive integer'],
    [-1, 0, 'Limit must be a positive integer'],
    [1.5, 0, 'Limit must be a positive integer'],
    [MAX_LIMIT + 1, 0, `Limit cannot exceed ${MAX_LIMIT}`],
    [10, -1, 'Offset must be a non-negative integer'],
    [10, MAX_OFFSET + 1, `Offset cannot exceed ${MAX_OFFSET}`],
  ])('limit %p, offset %p → BAD_USER_INPUT (%s)', (limit, offset, message) => {
    const error = failureOf(limit, offset);

    expect(error).toBeInstanceOf(GraphQLError);
    expect(error!.extensions.code).toBe('BAD_USER_INPUT');
    expect(error!.message).toContain(message);
  });

  test.each([
    [1, 0],
    [MAX_LIMIT, 0],
    [100, MAX_OFFSET],
  ])('limit %p, offset %p accepted', (limit, offset) => {
    expect(failureOf(limit, offset)).toBeUndefined();
  });

  test("l'offset vaut 0 par défaut (requêtes sans offset)", () => {
    expect(failureOf(50)).toBeUndefined();
  });
});
