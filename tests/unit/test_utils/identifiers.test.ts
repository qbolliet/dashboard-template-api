/**
 * Unit tests for the SQL identifier helpers (src/utils/identifiers.ts).
 *
 * quoteIdent must turn any column name into one inert identifier (quotes
 * doubled), qualifiedTable must quote every part, and assertColumns must
 * reject — with BAD_USER_INPUT, listing them all — the names absent from the
 * metadata table.
 */

import { GraphQLError } from 'graphql';
import { assertColumns, qualifiedTable, quoteIdent } from '../../../src/utils/identifiers.js';

// ─── quoteIdent ───────────────────────────────────────────────────────────────

describe('quoteIdent', () => {
  test.each([
    ['country', '"country"'],
    ['taux chômage', '"taux chômage"'],
    ['Année', '"Année"'],
    ["zone d'emploi", `"zone d'emploi"`],
    ['a"b', '"a""b"'],
    ['"', '""""'],
    ['x" OR 1=1 --', '"x"" OR 1=1 --"'],
    ['select', '"select"'],
  ])('%p → %s', (name, quoted) => {
    expect(quoteIdent(name)).toBe(quoted);
  });
});

// ─── qualifiedTable ───────────────────────────────────────────────────────────

describe('qualifiedTable', () => {
  test('quote catalogue, schéma et table', () => {
    expect(qualifiedTable('default', 'main', 'fact_table')).toBe('"default"."main"."fact_table"');
  });

  test('un schéma au nom non réduit à un identifiant nu reste résoluble', () => {
    expect(qualifiedTable('cat"a', 'mon schéma', 'metadata')).toBe(
      '"cat""a"."mon schéma"."metadata"',
    );
  });
});

// ─── assertColumns ────────────────────────────────────────────────────────────

describe('assertColumns', () => {
  const metadataByName = new Map<string, unknown>([
    ['country', {}],
    ['taux chômage', {}],
    ['a"b', {}],
  ]);

  /**
   * Returns the error thrown by assertColumns, if any.
   *
   * @param names - Names to check.
   * @returns The thrown error, or undefined.
   */
  const failureOf = (names: unknown[]): GraphQLError | undefined => {
    try {
      assertColumns(names, metadataByName, 'field');
      return undefined;
    } catch (error) {
      return error as GraphQLError;
    }
  };

  test('accepte les colonnes déclarées, quel que soit leur nom', () => {
    expect(failureOf(['country', 'taux chômage', 'a"b'])).toBeUndefined();
    expect(failureOf([])).toBeUndefined();
  });

  test('refuse en BAD_USER_INPUT en listant toutes les colonnes inconnues, sans doublon', () => {
    const error = failureOf(['country', 'nope', 'x y', 'nope']);

    expect(error).toBeInstanceOf(GraphQLError);
    expect(error!.extensions.code).toBe('BAD_USER_INPUT');
    expect(error!.message).toBe(
      'Unknown field column(s): "nope", "x y". They do not exist in the metadata table.',
    );
  });

  test('un nom vide ou non textuel est inconnu', () => {
    expect(failureOf([''])!.message).toContain('""');
    expect(failureOf([42])!.message).toContain('"42"');
    expect(failureOf([null])!.extensions.code).toBe('BAD_USER_INPUT');
  });

  test('le contexte nomme le rôle des colonnes', () => {
    expect(() => assertColumns(['nope'], metadataByName, 'sort')).toThrow(
      'Unknown sort column(s): "nope"',
    );
  });
});
