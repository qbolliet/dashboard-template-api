/**
 * Tests for bindParam (src/db/pool.ts) against a real in-memory DuckDB.
 *
 * Unlike pool.test.ts, @duckdb/node-api is NOT mocked here: the goal is to
 * verify the actual binding of large integers (> 2^31, up to 2^53 - 1) and the
 * comparisons emitted by treeToSQL on UBIGINT / DECIMAL / TIMESTAMP columns
 * (CAST(? AS <sql_type>)), including values beyond 2^53 sent as strings.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { bindParam } from '../../../src/db/pool.js';
import { treeToSQL, buildWhere } from '../../../src/utils/filter-tree.js';
import type { ColumnMetadata, FilterNodeInput } from '../../../src/utils/filter-tree.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Instance et connexion DuckDB en mémoire, partagées par les tests du fichier
let instance: DuckDBInstance;
let connection: DuckDBConnection;

// Métadonnées de la table de test (sql_type relu comme depuis la table metadata)
const metadataByName = new Map<string, ColumnMetadata>([
  ['id', { sql_type: 'UBIGINT' }],
  ['n', { sql_type: 'BIGINT' }],
  ['amount', { sql_type: 'DECIMAL(18,3)' }],
  ['ts', { sql_type: 'TIMESTAMP_NS' }],
  ['label', { sql_type: 'VARCHAR' }],
]);

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Runs a prepared statement with parameters bound through bindParam.
 *
 * @param sql - SQL statement with `?` placeholders.
 * @param params - Parameters to bind, in order.
 * @returns Result rows as JSON-compatible objects.
 */
// Exécution d'une requête préparée avec liaison via bindParam
async function run(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(sql);
  params.forEach((param, i) => bindParam(prepared, param, i + 1));
  const result = await prepared.run();
  return (await result.getRowObjectsJson()) as Record<string, unknown>[];
}

/**
 * Compiles a filter tree and returns the ids of the matching rows.
 *
 * @param tree - Filter tree (root group).
 * @returns Matching ids as strings, sorted.
 */
// Filtrage de la table de test par un arbre compilé
async function idsMatching(tree: FilterNodeInput): Promise<string[]> {
  const compiled = treeToSQL(tree, metadataByName);
  const rows = await run(`SELECT id FROM t ${buildWhere(compiled)} ORDER BY id`, compiled.params);
  return rows.map((r) => String(r.id));
}

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  await connection.run(`
    CREATE TABLE t (id UBIGINT, n BIGINT, amount DECIMAL(18,3), ts TIMESTAMP_NS, label VARCHAR);
    INSERT INTO t VALUES
      (1, 1, 1.250, '2024-01-01 00:00:00', '50% off'),
      (3000000000, 3000000000, 2.500, '2024-06-01 12:00:00', '50 off'),
      (9007199254740991, 9007199254740991, 3.750, '2025-01-01 00:00:00', 'a_b'),
      (18446744073709551615, -5, 4.000, '2030-01-01 00:00:00', 'axb');
  `);
});

afterAll(() => {
  connection?.closeSync();
  instance?.closeSync();
});

// ─── Liaison des entiers ─────────────────────────────────────────────────────

describe('bindParam — integers', () => {
  test('binds an integer beyond 2^31 without truncation', async () => {
    const rows = await run('SELECT CAST(? AS BIGINT) AS v', [3_000_000_000]);
    expect(String(rows[0].v)).toBe('3000000000');
  });

  test('binds 2^53 - 1 exactly', async () => {
    const rows = await run('SELECT CAST(? AS BIGINT) AS v', [Number.MAX_SAFE_INTEGER]);
    expect(String(rows[0].v)).toBe('9007199254740991');
  });

  test('binds negative integers beyond -2^31', async () => {
    const rows = await run('SELECT CAST(? AS BIGINT) AS v', [-3_000_000_000]);
    expect(String(rows[0].v)).toBe('-3000000000');
  });

  test('binds bigint values', async () => {
    const rows = await run('SELECT CAST(? AS BIGINT) AS v', [2n ** 62n]);
    expect(String(rows[0].v)).toBe(String(2n ** 62n));
  });

  test('binds small integers, doubles, booleans and null', async () => {
    const rows = await run('SELECT ? AS i, ? AS d, ? AS b, ? AS z', [42, 1.5, true, null]);
    expect(rows[0]).toMatchObject({ i: 42, d: 1.5, b: true, z: null });
  });
});

// ─── Comparaisons produites par treeToSQL ─────────────────────────────────────

describe('treeToSQL comparisons on a real table', () => {
  test('UBIGINT comparison with an integer > 2^31', async () => {
    const ids = await idsMatching({
      children: [{ criterion: { variable: 'id', operation: 'GTE', value: 3_000_000_000 } }],
    });
    expect(ids).toEqual(['3000000000', '9007199254740991', '18446744073709551615']);
  });

  test('UBIGINT equality beyond 2^53 via a numeric string', async () => {
    const ids = await idsMatching({
      children: [{ criterion: { variable: 'id', operation: 'EQ', value: '18446744073709551615' } }],
    });
    expect(ids).toEqual(['18446744073709551615']);
  });

  test('BIGINT IN list with a value > 2^31 and a negative value', async () => {
    const ids = await idsMatching({
      children: [{ criterion: { variable: 'n', operation: 'IN', value: [3_000_000_000, -5] } }],
    });
    expect(ids).toEqual(['3000000000', '18446744073709551615']);
  });

  test('DECIMAL BETWEEN mixing number and numeric string', async () => {
    const ids = await idsMatching({
      children: [
        { criterion: { variable: 'amount', operation: 'BETWEEN', value: { min: 2, max: '3.75' } } },
      ],
    });
    expect(ids).toEqual(['3000000000', '9007199254740991']);
  });

  test('TIMESTAMP_NS BETWEEN with ISO 8601 date and date-time', async () => {
    const ids = await idsMatching({
      children: [
        {
          criterion: {
            variable: 'ts',
            operation: 'BETWEEN',
            value: { min: '2024-03-01', max: '2025-01-01T00:00:00Z' },
          },
        },
      ],
    });
    expect(ids).toEqual(['3000000000', '9007199254740991']);
  });

  test('CONTAINS matches % and _ literally (escaped wildcards)', async () => {
    const percent = await idsMatching({
      children: [{ criterion: { variable: 'label', operation: 'CONTAINS', value: '0%' } }],
    });
    expect(percent).toEqual(['1']);

    const underscore = await idsMatching({
      children: [{ criterion: { variable: 'label', operation: 'CONTAINS', value: 'a_b' } }],
    });
    expect(underscore).toEqual(['9007199254740991']);
  });

  test('mixed AND/OR group keeps SQL precedence identical to the frontend', async () => {
    // id = 1 OR (n = -5 AND label STARTS 'ax')
    const ids = await idsMatching({
      children: [
        { criterion: { variable: 'id', operation: 'EQ', value: 1 } },
        {
          connector: 'OR',
          children: [
            { criterion: { variable: 'n', operation: 'EQ', value: -5 } },
            {
              connector: 'AND',
              criterion: { variable: 'label', operation: 'STARTS', value: 'ax' },
            },
          ],
        },
      ],
    });
    expect(ids).toEqual(['1', '18446744073709551615']);
  });
});
