/**
 * Tests of the DuckDB → JSON serialization (src/db/json-conversion.ts).
 *
 * Run on REAL DuckDB values, not mocks. The first block records what
 * getRowObjectsJson() / getRowsJson() of @duckdb/node-api return today for
 * BIGINT, UBIGINT, HUGEINT, DECIMAL, DATE, TIMESTAMP and FLOAT: it is the
 * finding that justifies the converter, and it fails loudly if a package
 * upgrade changes those defaults. The next blocks lock the target rules of the
 * single converter (safe integer → number, beyond → decimal string, DECIMAL /
 * FLOAT / DOUBLE → number, DATE / TIMESTAMP → ISO 8601, BOOLEAN, NULL) and the
 * page extents computed from it.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeExtents, jsonValueConverter } from '../../../src/db/json-conversion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Requêtes et état partagés ────────────────────────────────────────────────

type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

// Une valeur de chaque type de la spec, dont les cas limites de chaque règle
const LITERALS = `
  SELECT
    9007199254740993::BIGINT                       AS big,
    -9007199254740993::BIGINT                      AS neg_big,
    9007199254740991::BIGINT                       AS max_safe,
    42::BIGINT                                     AS small_big,
    18446744073709551615::UBIGINT                  AS ubig,
    7::UBIGINT                                     AS small_ubig,
    170141183460469231731687303715884105727::HUGEINT AS huge,
    5::HUGEINT                                     AS small_huge,
    12.50::DECIMAL(10,2)                           AS dec,
    3::INTEGER                                     AS int32,
    1.5::FLOAT                                     AS flt,
    0.1::FLOAT                                     AS flt_tenth,
    3.25::DOUBLE                                   AS dbl,
    'NaN'::DOUBLE                                  AS dbl_nan,
    'Infinity'::DOUBLE                             AS dbl_inf,
    '-Infinity'::FLOAT                             AS flt_ninf,
    DATE '2024-03-05'                              AS dt,
    DATE 'infinity'                                AS dt_inf,
    TIMESTAMP '2024-03-05 10:11:12'                AS ts,
    TIMESTAMP '2024-03-05 10:11:12.345'            AS ts_ms,
    TIMESTAMP_S '2024-03-05 10:11:12'              AS ts_s,
    TIMESTAMP_NS '2024-03-05 10:11:12.123456789'   AS ts_ns,
    TIMESTAMPTZ '2024-03-05 10:11:12+00'           AS ts_tz,
    TRUE                                           AS bool_true,
    NULL::BIGINT                                   AS nul,
    [9007199254740993::BIGINT, 1::BIGINT]          AS nested
`;

let instance: Awaited<ReturnType<typeof DuckDBInstance.create>>;
let connection: Connection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  await connection.run('LOAD ducklake;');
  const catalogFile = path.resolve(__dirname, '../../../data/test-default.ducklake');
  await connection.run(
    `ATTACH 'ducklake:${catalogFile.replace(/\\/g, '/')}' AS "default" (READ_ONLY)`,
  );
});

afterAll(() => {
  connection.closeSync();
  instance.closeSync();
});

/**
 * Runs a query and returns its single row, converted by the API converter.
 *
 * @param sql - Query returning one row.
 * @returns The row as a JSON object.
 */
// Première ligne d'une requête, convertie par le convertisseur unique
async function convertedRow(sql: string): Promise<Record<string, unknown>> {
  const result = await connection.run(sql);
  return (await result.convertRowObjects(jsonValueConverter))[0];
}

/**
 * Runs a query and returns what the pool feeds to computeExtents.
 *
 * @param sql - Query to run.
 * @returns Column names, DuckDB column types and converted rows.
 */
// Page telle que la voit getWithMetadata : noms, types DuckDB, lignes converties
async function convertedPage(sql: string) {
  const result = await connection.run(sql);
  const names = result.columnNames();
  const types = result.columnTypes();
  const rows = await result.convertRowObjects(jsonValueConverter);
  return { names, types, rows };
}

// ─── Constat : ce que renvoient les accesseurs JSON du paquet ─────────────────

describe('baseline — getRowObjectsJson / getRowsJson of @duckdb/node-api', () => {
  test('serializes every integer wider than 32 bits as a string, small ones included', async () => {
    const [row] = await (await connection.run(LITERALS)).getRowObjectsJson();

    expect(row.big).toBe('9007199254740993');
    expect(row.small_big).toBe('42'); // BIGINT ordinaire : chaîne aussi
    expect(row.ubig).toBe('18446744073709551615');
    expect(row.small_ubig).toBe('7');
    expect(row.huge).toBe('170141183460469231731687303715884105727');
    expect(row.small_huge).toBe('5');
    expect(row.int32).toBe(3); // INTEGER : nombre
  });

  test('serializes DECIMAL as a string and non-finite doubles as strings', async () => {
    const [row] = await (await connection.run(LITERALS)).getRowObjectsJson();

    expect(row.dec).toBe('12.50');
    expect(row.dbl_nan).toBe('NaN');
    expect(row.dbl_inf).toBe('Infinity');
  });

  test('widens a FLOAT to its double expansion', async () => {
    const [row] = await (await connection.run(LITERALS)).getRowObjectsJson();

    expect(row.flt).toBe(1.5);
    expect(row.flt_tenth).toBe(0.10000000149011612);
  });

  test('serializes DATE as ISO, TIMESTAMP with a space separator and TIMESTAMPTZ in the session zone', async () => {
    const [row] = await (await connection.run(LITERALS)).getRowObjectsJson();

    expect(row.dt).toBe('2024-03-05');
    expect(row.ts).toBe('2024-03-05 10:11:12');
    expect(row.ts_ms).toBe('2024-03-05 10:11:12.345');
    // Le TIMESTAMPTZ suit le fuseau de session : décalage « +02 », pas un « Z »
    expect(row.ts_tz).toMatch(/^2024-03-05 \d{2}:11:12[+-]\d{2}$/);
  });

  test('getRowsJson agrees with getRowObjectsJson', async () => {
    const result = await connection.run(LITERALS);
    const names = result.columnNames();
    const [row] = await result.getRowsJson();

    expect(row[names.indexOf('big')]).toBe('9007199254740993');
    expect(row[names.indexOf('dec')]).toBe('12.50');
    expect(row[names.indexOf('ts')]).toBe('2024-03-05 10:11:12');
  });

  test('returns the BIGINT above 2^53 of the test setup as a string', async () => {
    const rows = await (
      await connection.run('SELECT DISTINCT budget FROM "default".geography.fact_table')
    ).getRowObjectsJson();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(typeof row.budget).toBe('string');
  });
});

// ─── Règles du convertisseur unique ───────────────────────────────────────────

describe('jsonValueConverter — integers', () => {
  test('turns a safe integer into a number, BIGINT included', async () => {
    const row = await convertedRow(LITERALS);

    expect(row.small_big).toBe(42);
    expect(row.max_safe).toBe(Number.MAX_SAFE_INTEGER);
    expect(row.small_ubig).toBe(7);
    expect(row.small_huge).toBe(5);
    expect(row.int32).toBe(3);
  });

  test('turns an integer beyond 2^53 into its exact decimal string', async () => {
    const row = await convertedRow(LITERALS);

    expect(row.big).toBe('9007199254740993');
    expect(row.neg_big).toBe('-9007199254740993');
    expect(row.ubig).toBe('18446744073709551615');
    expect(row.huge).toBe('170141183460469231731687303715884105727');
  });

  test('serializes the BIGINT of the test setup: above 2^53 as a string, ordinary as a number', async () => {
    const big = await convertedRow(
      'SELECT MIN(budget) AS budget FROM "default".geography.fact_table',
    );
    const ordinary = await convertedRow(
      `SELECT MIN(headcount) AS headcount FROM "default".main.fact_table WHERE kind = 'Forecast'`,
    );
    const beyond = await convertedRow(
      `SELECT MIN(headcount) AS headcount FROM "default".main.fact_table WHERE kind = 'Actual'`,
    );

    expect(big.budget).toBe('9007199254740995');
    expect(ordinary.headcount).toBe(1234567);
    expect(typeof beyond.headcount).toBe('string');
    expect(BigInt(beyond.headcount as string)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  test('serializes the UBIGINT of the test setup as a number', async () => {
    const row = await convertedRow(
      'SELECT MIN(population) AS population FROM "default".geography.fact_table',
    );

    expect(typeof row.population).toBe('number');
  });
});

describe('jsonValueConverter — decimals and floats', () => {
  test('turns DECIMAL into a number', async () => {
    expect((await convertedRow(LITERALS)).dec).toBe(12.5);
  });

  test('turns FLOAT and DOUBLE into numbers, FLOAT without its double expansion', async () => {
    const row = await convertedRow(LITERALS);

    expect(row.flt).toBe(1.5);
    expect(row.flt_tenth).toBe(0.1);
    expect(row.dbl).toBe(3.25);
  });

  test('turns NaN and ±Infinity into null', async () => {
    const row = await convertedRow(LITERALS);

    expect(row.dbl_nan).toBeNull();
    expect(row.dbl_inf).toBeNull();
    expect(row.flt_ninf).toBeNull();
  });
});

describe('jsonValueConverter — dates and timestamps', () => {
  test('turns DATE into YYYY-MM-DD', async () => {
    expect((await convertedRow(LITERALS)).dt).toBe('2024-03-05');
  });

  test('turns a DATE with no ISO form (infinity) into null', async () => {
    expect((await convertedRow(LITERALS)).dt_inf).toBeNull();
  });

  test('turns TIMESTAMP into ISO 8601 with a T separator, fraction only when present', async () => {
    const row = await convertedRow(LITERALS);

    expect(row.ts).toBe('2024-03-05T10:11:12');
    expect(row.ts_ms).toBe('2024-03-05T10:11:12.345');
    expect(row.ts_s).toBe('2024-03-05T10:11:12');
    expect(row.ts_ns).toBe('2024-03-05T10:11:12.123456789');
  });

  test('turns TIMESTAMPTZ into UTC with a Z suffix, whatever the session time zone', async () => {
    await connection.run(`SET TimeZone = 'Asia/Tokyo'`);
    try {
      expect((await convertedRow(LITERALS)).ts_tz).toBe('2024-03-05T10:11:12Z');
    } finally {
      await connection.run(`RESET TimeZone`);
    }
  });

  test('gives the zone-less TIMESTAMP of the test setup no Z suffix', async () => {
    const row = await convertedRow(
      'SELECT MIN(ingested_at) AS ingested_at FROM "default".main.fact_table',
    );

    expect(row.ingested_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe('jsonValueConverter — other types', () => {
  test('keeps BOOLEAN as a boolean and NULL as null', async () => {
    const row = await convertedRow(LITERALS);

    expect(row.bool_true).toBe(true);
    expect(row.nul).toBeNull();
  });

  test('applies the rules inside nested values', async () => {
    expect((await convertedRow(LITERALS)).nested).toEqual(['9007199254740993', 1]);
  });

  test('serializes the rows of getRowsJson-style arrays the same way', async () => {
    const result = await connection.run(LITERALS);
    const names = result.columnNames();
    const [row] = await result.convertRows(jsonValueConverter);

    expect(row[names.indexOf('big')]).toBe('9007199254740993');
    expect(row[names.indexOf('dec')]).toBe(12.5);
    expect(row[names.indexOf('ts')]).toBe('2024-03-05T10:11:12');
    expect(row[names.indexOf('nul')]).toBeNull();
  });
});

// ─── Extents de page ──────────────────────────────────────────────────────────

describe('computeExtents', () => {
  const PAGE = `
    SELECT * FROM (VALUES
      (3::BIGINT,  9007199254740993::BIGINT, 2.5::DECIMAL(6,2), DATE '2024-03-05', TIMESTAMP '2024-03-05 10:11:12.5', TIMESTAMPTZ '2024-03-05 10:11:12.5+00', 'b', NULL::DOUBLE, TRUE),
      (1::BIGINT,  7::BIGINT,                -1.5::DECIMAL(6,2), DATE '2023-12-31', TIMESTAMP '2024-03-05 10:11:12',   TIMESTAMPTZ '2024-03-05 10:11:12+00',   'a', NULL::DOUBLE, FALSE),
      (NULL,       NULL,                     NULL,               NULL,              NULL,                              NULL,                                   NULL, NULL::DOUBLE, NULL)
    ) t(n, big, dec, dt, ts, tstz, txt, empty, flag)
  `;

  test('covers numeric columns, integers converted from BIGINT included', async () => {
    const { names, types, rows } = await convertedPage(PAGE);
    const extents = computeExtents(names, types, rows);

    expect(extents.n).toEqual([1, 3]);
    expect(extents.dec).toEqual([-1.5, 2.5]);
  });

  test('covers a BIGINT column holding a value beyond 2^53, bound approximate', async () => {
    const { names, types, rows } = await convertedPage(PAGE);
    const extents = computeExtents(names, types, rows);

    expect(extents.big).toEqual([7, 9007199254740992]);
  });

  test('covers date columns with ISO string bounds', async () => {
    const { names, types, rows } = await convertedPage(PAGE);

    expect(computeExtents(names, types, rows).dt).toEqual(['2023-12-31', '2024-03-05']);
  });

  test('covers timestamp columns with ISO string bounds, in chronological order', async () => {
    const { names, types, rows } = await convertedPage(PAGE);
    const extents = computeExtents(names, types, rows);

    expect(extents.ts).toEqual(['2024-03-05T10:11:12', '2024-03-05T10:11:12.5']);
    // « …12Z » précède « …12.5Z » chronologiquement, alors que 'Z' > '.' en ordre lexical
    expect(extents.tstz).toEqual(['2024-03-05T10:11:12Z', '2024-03-05T10:11:12.5Z']);
  });

  test('ignores NULLs and gives no entry to a column without any value', async () => {
    const { names, types, rows } = await convertedPage(PAGE);
    const extents = computeExtents(names, types, rows);

    expect(extents.n).toEqual([1, 3]); // la ligne NULL n'élargit pas les bornes
    expect(extents).not.toHaveProperty('empty');
  });

  test('gives no entry to text and boolean columns', async () => {
    const { names, types, rows } = await convertedPage(PAGE);
    const extents = computeExtents(names, types, rows);

    expect(extents).not.toHaveProperty('txt');
    expect(extents).not.toHaveProperty('flag');
  });

  test('compares dates chronologically, not by their order in the page', async () => {
    const { names, types, rows } = await convertedPage(
      `SELECT * FROM (VALUES (DATE '2024-06-01'), (DATE '2023-01-15'), (DATE '2024-01-31')) t(d)`,
    );

    expect(computeExtents(names, types, rows).d).toEqual(['2023-01-15', '2024-06-01']);
  });
});
