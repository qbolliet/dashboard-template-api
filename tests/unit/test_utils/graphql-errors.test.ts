/**
 * Unit tests for the GraphQL error formatting (src/utils/graphql-errors.ts).
 *
 * Client errors keep their message in production, internal errors and
 * unknown codes are masked, errorId is always present and the stack trace
 * never is. Each error is logged once, as a warning for a client error.
 */

import { jest, describe, test, expect } from '@jest/globals';
import { GraphQLError } from 'graphql';
import type { GraphQLFormattedError } from 'graphql';
import {
  PUBLIC_ERROR_CODES,
  errorCodeOf,
  formatGraphQLError,
  logGraphQLError,
} from '../../../src/utils/graphql-errors.js';
import type { ContextLogger } from '../../../src/utils/logger.js';

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/**
 * Builds an error as formatted by Apollo Server.
 *
 * @param code - Extension code, omitted when undefined.
 * @param message - Error message.
 * @returns The formatted error, with location, path and stack trace.
 */
const formatted = (
  code: string | undefined,
  message = 'Column "nope" does not exist',
): GraphQLFormattedError => ({
  message,
  locations: [{ line: 1, column: 3 }],
  path: ['getFactTable'],
  extensions: {
    ...(code ? { code } : {}),
    stacktrace: ['Error: internal', '    at secret (/app/src/db/pool.ts:1:1)'],
    complexity: 250,
  },
});

/**
 * Builds a logger whose methods are spies.
 *
 * @returns The spied logger.
 */
const spyLogger = (): ContextLogger & { warn: jest.Mock; error: jest.Mock } =>
  ({
    operation: jest.fn(),
    database: jest.fn(),
    cache: jest.fn(),
    performance: jest.fn(),
    security: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }) as unknown as ContextLogger & { warn: jest.Mock; error: jest.Mock };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('formatGraphQLError', () => {
  describe('production', () => {
    const production = { errorId: 'id-1', production: true };

    test.each([
      'BAD_USER_INPUT',
      'SCHEMA_VERSION_UNSUPPORTED',
      'QUERY_COMPLEXITY_EXCEEDED',
      'GRAPHQL_VALIDATION_FAILED',
    ])('keeps the message of %s', (code) => {
      const result = formatGraphQLError(formatted(code), production);
      expect(result.message).toBe('Column "nope" does not exist');
      expect(result.path).toEqual(['getFactTable']);
      expect(result.locations).toEqual([{ line: 1, column: 3 }]);
      // Extensions utiles au client conservées (score de complexité…)
      expect(result.extensions).toEqual({ code, complexity: 250, errorId: 'id-1' });
    });

    test('masks INTERNAL_SERVER_ERROR, keeping only code and errorId', () => {
      const result = formatGraphQLError(
        formatted('INTERNAL_SERVER_ERROR', 'Binder Error: secret SQL'),
        production,
      );
      expect(result).toEqual({
        message: 'An error occurred',
        extensions: { code: 'INTERNAL_SERVER_ERROR', errorId: 'id-1' },
      });
    });

    test('masks an unknown code', () => {
      const result = formatGraphQLError(formatted('SOMETHING_ELSE', 'internal detail'), production);
      expect(result.message).toBe('An error occurred');
      expect(result.extensions).toEqual({ code: 'SOMETHING_ELSE', errorId: 'id-1' });
    });

    test('treats an error without code as INTERNAL_SERVER_ERROR', () => {
      const result = formatGraphQLError(formatted(undefined, 'internal detail'), production);
      expect(result.message).toBe('An error occurred');
      expect(result.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  describe('development', () => {
    test('keeps the message of an internal error, without the stack trace', () => {
      const result = formatGraphQLError(formatted('INTERNAL_SERVER_ERROR', 'Binder Error'), {
        errorId: 'id-2',
        production: false,
      });
      expect(result.message).toBe('Binder Error');
      expect(result.extensions?.['errorId']).toBe('id-2');
      expect(result.extensions).not.toHaveProperty('stacktrace');
    });
  });

  test('never sends the stack trace of a client error', () => {
    const result = formatGraphQLError(formatted('BAD_USER_INPUT'), {
      errorId: 'id-3',
      production: true,
    });
    expect(result.extensions).not.toHaveProperty('stacktrace');
  });
});

describe('PUBLIC_ERROR_CODES', () => {
  test('never exposes INTERNAL_SERVER_ERROR', () => {
    expect(PUBLIC_ERROR_CODES.has('INTERNAL_SERVER_ERROR')).toBe(false);
  });

  test('reads a missing code as INTERNAL_SERVER_ERROR', () => {
    expect(errorCodeOf(undefined)).toBe('INTERNAL_SERVER_ERROR');
    expect(errorCodeOf({ code: 42 })).toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('logGraphQLError', () => {
  test('logs a client error once, as a warning without stack trace', () => {
    const log = spyLogger();
    const error = new GraphQLError('Limit cannot exceed 1000', {
      extensions: { code: 'BAD_USER_INPUT' },
    });

    logGraphQLError(log, error, 'id-4');

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    const [message, details] = log.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('Limit cannot exceed 1000');
    expect(details).toMatchObject({ errorId: 'id-4', code: 'BAD_USER_INPUT' });
    expect(details).not.toHaveProperty('stack');
  });

  test('logs an internal error once, as an error with the stack of its cause', () => {
    const log = spyLogger();
    const cause = new Error('Binder Error');
    const error = new GraphQLError('Binder Error', { originalError: cause });

    logGraphQLError(log, error, 'id-5');

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const details = log.error.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(details).toMatchObject({ errorId: 'id-5', code: 'INTERNAL_SERVER_ERROR' });
    expect(details['stack']).toBe(cause.stack);
  });
});
