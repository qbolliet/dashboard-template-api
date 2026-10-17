/**
 * Unit tests for toLoaderError (src/loaders/loader-errors.ts).
 *
 * The messages below are the ones DuckDB actually raises (checked on the
 * installed @duckdb/node-api). An error caused by the request must become a
 * BAD_USER_INPUT GraphQLError; a server-side error must stay a plain Error,
 * reported as INTERNAL_SERVER_ERROR with an errorId by formatError.
 */

import { GraphQLError } from 'graphql';
import { toLoaderError } from '../../../src/loaders/loader-errors.js';

describe('toLoaderError', () => {
  test.each([
    [
      'Binder Error: Referenced column "nope" not found in FROM clause!\nCandidate bindings: "a"\n\nLINE 1: ...',
      'Binder Error: Referenced column "nope" not found in FROM clause!',
    ],
    [
      "Binder Error: No function matches the given name and argument types 'sum(VARCHAR)'. You might need to add explicit type casts.\n\tCandidate functions:",
      "Binder Error: No function matches the given name and argument types 'sum(VARCHAR)'. You might need to add explicit type casts.",
    ],
    [
      'Binder Error: LIMIT/OFFSET cannot be negative\n\nLINE 1: ...',
      'Binder Error: LIMIT/OFFSET cannot be negative',
    ],
    [
      "Conversion Error: Could not convert string 'x' to INT32\n\nLINE 1: ...",
      "Conversion Error: Could not convert string 'x' to INT32",
    ],
    [
      'Invalid Input Error: invalid perl operator: (?<',
      'Invalid Input Error: invalid perl operator: (?<',
    ],
    ['Invalid Input Error: missing ): (', 'Invalid Input Error: missing ): ('],
  ])('erreur due à la requête → BAD_USER_INPUT : %p', (message, firstLine) => {
    const original = new Error(message);
    const mapped = toLoaderError(original);

    expect(mapped).toBeInstanceOf(GraphQLError);
    expect((mapped as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
    expect(mapped.message).toBe(firstLine);
    expect((mapped as GraphQLError).originalError).toBe(original);
  });

  test.each([
    'Binder Error: Catalog "nope" does not exist!',
    'Catalog Error: Table with name fact_table does not exist!',
    'IO Error: Could not read file "s3://bucket/x.parquet"',
    'HTTP Error: Unable to connect',
    'Pool exhausted',
  ])('erreur serveur → erreur d’origine inchangée : %p', (message) => {
    const original = new Error(message);
    expect(toLoaderError(original)).toBe(original);
  });

  test('une GraphQLError est rendue telle quelle', () => {
    const original = new GraphQLError('Unknown field', { extensions: { code: 'BAD_USER_INPUT' } });
    expect(toLoaderError(original)).toBe(original);
  });

  test("une Error d'un autre realm (binding natif, contexte VM) est reconnue", () => {
    const foreign = { name: 'Error', message: 'Invalid Input Error: bad repetition operator: ++' };
    const mapped = toLoaderError(foreign);

    expect(mapped).toBeInstanceOf(GraphQLError);
    expect(mapped.message).toBe('Invalid Input Error: bad repetition operator: ++');
  });

  test('une valeur non Error est enveloppée dans une Error', () => {
    const mapped = toLoaderError('boom');
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped.message).toBe('boom');
  });
});
