/**
 * Nested schemas (DuckLake 1.1) on a real DuckLake catalog.
 *
 * A nested schema is named by its full path (`sales.europe`): the discovery
 * must report that path (the engine only reports the last level), the
 * qualified name must reach the table through every level, and the column
 * positions must come from the right schema when two nested schemas share
 * their last level (`sales.europe` and `costs.europe`).
 */

import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listCatalogSchemas } from '../../../src/db/pool.js';
import { COLUMN_POSITIONS_SQL } from '../../../src/loaders/catalog.js';
import { qualifiedTable } from '../../../src/utils/identifiers.js';

// ─── Catalogue d'essai ────────────────────────────────────────────────────────

let instance: DuckDBInstance;
let connection: DuckDBConnection;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-schemas-'));
  const root = tmpDir.split(path.sep).join('/');
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  await connection.run('LOAD ducklake');
  await connection.run(
    `ATTACH 'ducklake:${root}/lake.ducklake' AS lake (DATA_PATH '${root}/data/')`,
  );
  // Deux schémas imbriqués de même dernier niveau, colonnes dans un ordre différent
  for (const statement of [
    'CREATE SCHEMA lake.sales',
    'CREATE SCHEMA lake.sales.europe',
    'CREATE SCHEMA lake.costs',
    'CREATE SCHEMA lake.costs.europe',
    'CREATE SCHEMA lake.costs.europe.west',
    "CREATE TABLE lake.sales.europe.fact_table AS SELECT 'FR' AS country, 1 AS value",
    "CREATE TABLE lake.costs.europe.fact_table AS SELECT 2 AS value, 'DE' AS country",
    'CREATE TABLE lake.costs.europe.west.fact_table AS SELECT 3 AS value',
  ]) {
    await connection.run(statement);
  }
}, 60000);

afterAll(() => {
  connection.closeSync();
  instance.closeSync();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('nested schemas', () => {
  test('the discovery reports every schema by its full path', async () => {
    const discovered = await listCatalogSchemas(connection, ['lake']);

    expect([...discovered.lake].sort()).toEqual([
      'costs',
      'costs.europe',
      'costs.europe.west',
      'main',
      'sales',
      'sales.europe',
    ]);
  });

  test('the qualified name reaches the table through every level', async () => {
    const rows = await connection.runAndReadAll(
      `SELECT value FROM ${qualifiedTable('lake', 'costs.europe.west', 'fact_table')}`,
    );

    expect(rows.getRows()).toEqual([[3]]);
  });

  test.each([
    [
      'sales.europe',
      [
        ['country', 1],
        ['value', 2],
      ],
    ],
    [
      'costs.europe',
      [
        ['value', 1],
        ['country', 2],
      ],
    ],
    ['costs.europe.west', [['value', 1]]],
    ['europe', []],
    ['sales', []],
  ])('the column positions of %s come from that schema only', async (schema, expected) => {
    const reader = await connection.runAndReadAll(COLUMN_POSITIONS_SQL, ['lake', schema]);
    const positions = reader
      .getRowObjectsJson()
      .map((row) => [row.column_name, row.column_index])
      .sort((a, b) => Number(a[1]) - Number(b[1]));

    expect(positions).toEqual(expected);
  });
});
