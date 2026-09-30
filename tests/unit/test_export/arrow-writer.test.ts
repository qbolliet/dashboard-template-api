/**
 * Tests of the DuckDB → Arrow conversion (src/export/arrow-writer.ts).
 *
 * Run on REAL DuckDB chunks: one literal of each type of the database
 * specification, a NULL row, negative and wide decimals, every timestamp
 * unit, and a multi-chunk result. The batches are serialized to an IPC stream
 * and read back by apache-arrow, exactly as a client of /api/export would.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { RecordBatchStreamWriter, tableFromIPC } from 'apache-arrow';
import type { RecordBatch, Table } from 'apache-arrow';
import {
  buildArrowLayout,
  chunkToRecordBatch,
  emptyRecordBatch,
} from '../../../src/export/arrow-writer.js';
import type { ExportDescription } from '../../../src/export/embedded-metadata.js';
import type { FieldMetadata } from '../../../src/utils/metadata-mapping.js';

let instance: DuckDBInstance;
let connection: DuckDBConnection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
});

afterAll(() => {
  connection.closeSync();
  instance.closeSync();
});

/**
 * Streams a query through the Arrow writer and reads the IPC stream back.
 *
 * @param sql - Query to convert.
 * @returns The Arrow table read back, and the number of batches written.
 */
// Aller-retour complet : chunks DuckDB → RecordBatch → flux IPC → Table
const roundTrip = async (
  sql: string,
  description?: ExportDescription,
): Promise<{ table: Table; batches: number }> => {
  const result = await connection.stream(sql);
  const layout = buildArrowLayout(result.columnNames(), result.columnTypes(), description);
  const batches: RecordBatch[] = [];
  for await (const chunk of result) {
    if (chunk.rowCount > 0) batches.push(chunkToRecordBatch(chunk, layout));
  }
  if (batches.length === 0) batches.push(emptyRecordBatch(layout));
  const bytes = RecordBatchStreamWriter.writeAll(batches).toUint8Array(true);
  return { table: tableFromIPC(bytes), batches: batches.length };
};

// Un littéral par type de la spécification, puis une ligne entièrement NULL
const ALL_TYPES = `
  SELECT * FROM (VALUES
    (-5::TINYINT, -300::SMALLINT, -70000::INTEGER, -9007199254740993::BIGINT,
     250::UTINYINT, 65000::USMALLINT, 4000000000::UINTEGER, 18446744073709551615::UBIGINT,
     1.5::FLOAT, 3.25::DOUBLE, -12.345::DECIMAL(10,3), 12345678901234567890.12::DECIMAL(38,2),
     DATE '2024-03-05', TIMESTAMP '2024-03-05 10:11:12.345678',
     TIMESTAMP_S '2024-03-05 10:11:12', TIMESTAMP_MS '2024-03-05 10:11:12.345',
     TIMESTAMP_NS '2024-03-05 10:11:12.123456789', TIMESTAMPTZ '2024-03-05 10:11:12+00',
     TRUE, 'Côte-d''Or', 99999999999999999999999999999999999999::HUGEINT,
     -99999999999999999999999999999999999999::HUGEINT, 12345678901234567890123456789::UHUGEINT),
    (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  ) t(ti, si, i, bi, uti, usi, ui, ubi, f, d, dec, wide_dec, dt, ts, ts_s, ts_ms, ts_ns, tstz,
      b, s, huge, neg_huge, uhuge)
`;

describe('buildArrowLayout / chunkToRecordBatch', () => {
  test('maps every specification type to its exact Arrow type', async () => {
    const { table } = await roundTrip(ALL_TYPES);
    const types = Object.fromEntries(table.schema.fields.map((f) => [f.name, String(f.type)]));

    expect(types).toEqual({
      ti: 'Int8',
      si: 'Int16',
      i: 'Int32',
      bi: 'Int64',
      uti: 'Uint8',
      usi: 'Uint16',
      ui: 'Uint32',
      ubi: 'Uint64',
      f: 'Float32',
      d: 'Float64',
      // Notation apache-arrow : Decimal[<précision>e+<échelle>]
      dec: 'Decimal[10e+3]',
      wide_dec: 'Decimal[38e+2]',
      dt: 'Date32<DAY>',
      ts: 'Timestamp<MICROSECOND>',
      ts_s: 'Timestamp<SECOND>',
      ts_ms: 'Timestamp<MILLISECOND>',
      ts_ns: 'Timestamp<NANOSECOND>',
      tstz: 'Timestamp<MICROSECOND, UTC>',
      b: 'Bool',
      s: 'Utf8',
      // Entiers 128 bits : Decimal128(38, 0)
      huge: 'Decimal[38e0]',
      neg_huge: 'Decimal[38e0]',
      uhuge: 'Decimal[38e0]',
    });

    // Précision et échelle vérifiées sur le type lui-même
    const decimal = (name: string): { precision: number; scale: number; bitWidth: number } =>
      table.schema.fields.find((f) => f.name === name)!.type as never;
    expect(decimal('dec')).toMatchObject({ precision: 10, scale: 3, bitWidth: 128 });
    expect(decimal('wide_dec')).toMatchObject({ precision: 38, scale: 2, bitWidth: 128 });
    for (const name of ['huge', 'neg_huge', 'uhuge']) {
      expect(decimal(name)).toMatchObject({ precision: 38, scale: 0, bitWidth: 128 });
    }
  });

  test('preserves the values, including 64-bit extremes', async () => {
    const { table } = await roundTrip(ALL_TYPES);
    const row = table.get(0)!;

    expect(row['ti']).toBe(-5);
    expect(row['i']).toBe(-70000);
    expect(row['bi']).toBe(-9007199254740993n);
    expect(row['ui']).toBe(4000000000);
    expect(row['ubi']).toBe(18446744073709551615n);
    expect(row['f']).toBe(1.5);
    expect(row['d']).toBe(3.25);
    expect(row['b']).toBe(true);
    expect(row['s']).toBe("Côte-d'Or");

    // Dates et horodatages : lecture brute des entiers stockés (jours, µs, s, ms, ns)
    const raw = (name: string): unknown => table.getChild(name)!.data[0].values[0];
    expect(raw('dt')).toBe(19787);
    expect(raw('ts')).toBe(1709633472345678n);
    expect(raw('ts_s')).toBe(1709633472n);
    expect(raw('ts_ms')).toBe(1709633472345n);
    expect(raw('ts_ns')).toBe(1709633472123456789n);
    expect(raw('tstz')).toBe(1709633472000000n);
  });

  test('encodes DECIMAL as two-complement 128-bit words (negative and wide)', async () => {
    const { table } = await roundTrip(ALL_TYPES);
    const words = (name: string): bigint => {
      const values = table.getChild(name)!.data[0].values as Uint32Array;
      let v = 0n;
      for (let w = 3; w >= 0; w--) v = (v << 32n) | BigInt(values[w]);
      return BigInt.asIntN(128, v);
    };

    expect(words('dec')).toBe(-12345n);
    expect(words('wide_dec')).toBe(1234567890123456789012n);
  });

  test('writes HUGEINT and UHUGEINT as exact 128-bit integers, negatives included', async () => {
    const { table } = await roundTrip(ALL_TYPES);
    const words = (name: string): bigint => {
      const values = table.getChild(name)!.data[0].values as Uint32Array;
      let v = 0n;
      for (let w = 3; w >= 0; w--) v = (v << 32n) | BigInt(values[w]);
      return BigInt.asIntN(128, v);
    };

    expect(words('huge')).toBe(10n ** 38n - 1n);
    expect(words('neg_huge')).toBe(-(10n ** 38n - 1n));
    expect(words('uhuge')).toBe(12345678901234567890123456789n);
  });

  test.each([
    ['HUGEINT above 10^38', '170141183460469231731687303715884105727::HUGEINT'],
    ['HUGEINT below -10^38', '(-170141183460469231731687303715884105727)::HUGEINT'],
    [
      'UHUGEINT above 2^127 (would wrap negative)',
      '340282366920938463463374607431768211455::UHUGEINT',
    ],
  ])('refuses a %s rather than writing a corrupt Decimal128', async (_label, literal) => {
    await expect(roundTrip(`SELECT ${literal} AS v`)).rejects.toThrow(RangeError);
  });

  test('writes NULL through the validity bitmap for every type', async () => {
    const { table } = await roundTrip(ALL_TYPES);
    const row = table.get(1)!.toJSON() as Record<string, unknown>;

    for (const field of table.schema.fields) {
      expect(row[field.name]).toBeNull();
    }
  });

  test('converts a multi-chunk result into several batches', async () => {
    const { table, batches } = await roundTrip(
      "SELECT i::BIGINT AS i, 'v' || i AS s FROM range(5000) t(i)",
    );

    expect(batches).toBeGreaterThan(1);
    expect(table.numRows).toBe(5000);
    expect(table.get(4999)!['i']).toBe(4999n);
    expect(table.get(4999)!['s']).toBe('v4999');
  });

  test('an empty result keeps its schema', async () => {
    const { table } = await roundTrip('SELECT 1::INTEGER AS a, 2::VARCHAR AS b WHERE false');

    expect(table.numRows).toBe(0);
    expect(table.schema.fields.map((f) => `${f.name}:${String(f.type)}`)).toEqual([
      'a:Int32',
      'b:Utf8',
    ]);
  });
});

// ─── Métadonnées embarquées ──────────────────────────────────────────────────

/**
 * Builds a metadata row, the unset fields being null.
 *
 * @param fields - Fields to override.
 * @returns A complete FieldMetadata.
 */
const column = (fields: Partial<FieldMetadata> & { name: string }): FieldMetadata => ({
  label: fields.name,
  sqlType: 'VARCHAR',
  isPrimaryKey: false,
  isCategorical: false,
  parentName: null,
  labelFor: null,
  labelFields: [],
  unit: null,
  displayFormat: null,
  family: null,
  description: null,
  defaultAggregation: null,
  ...fields,
});

const DESCRIPTION: ExportDescription = {
  columns: [
    column({
      name: 'region',
      label: 'Région',
      isPrimaryKey: true,
      labelFields: ['region_libelle'],
    }),
    column({ name: 'region_libelle', labelFor: 'region' }),
    column({
      name: 'population',
      label: 'Population',
      sqlType: 'BIGINT',
      unit: 'hab.',
      displayFormat: ',.0f',
      description: "Population légale (recensement de l'année)",
    }),
  ],
  dataset: {
    label: 'Géographie',
    description: null,
    source: 'INSEE',
    updatedAt: '2024-05-01T08:00:00Z',
    schemaVersion: 2,
    clusterBy: ['region'],
  },
};

describe('embedded metadata', () => {
  const SQL =
    "SELECT 'A' AS region, 'Alpha' AS region_libelle, 12::BIGINT AS population, 1 AS untouched";

  test('each field carries label, unit, displayFormat, description, isPrimaryKey and labelFor', async () => {
    const { table } = await roundTrip(SQL, DESCRIPTION);
    const meta = (name: string): Record<string, string> =>
      Object.fromEntries(table.schema.fields.find((f) => f.name === name)!.metadata);

    expect(meta('region')).toEqual({ label: 'Région', isPrimaryKey: 'true' });
    expect(meta('region_libelle')).toEqual({
      label: 'region_libelle',
      isPrimaryKey: 'false',
      labelFor: 'region',
    });
    expect(meta('population')).toEqual({
      label: 'Population',
      unit: 'hab.',
      displayFormat: ',.0f',
      description: "Population légale (recensement de l'année)",
      isPrimaryKey: 'false',
    });
    // Colonne absente de la description : aucune métadonnée
    expect(meta('untouched')).toEqual({});
  });

  test('the schema carries the dataset and the column rows as JSON, typeFamily included', async () => {
    const { table } = await roundTrip(SQL, DESCRIPTION);

    expect(JSON.parse(table.schema.metadata.get('database.dataset')!)).toEqual(DESCRIPTION.dataset);
    const rows = JSON.parse(table.schema.metadata.get('database.metadata')!) as Record<
      string,
      unknown
    >[];
    expect(rows.map((r) => r['name'])).toEqual(['region', 'region_libelle', 'population']);
    expect(rows[2]).toMatchObject({ sqlType: 'BIGINT', typeFamily: 'INTEGER', unit: 'hab.' });
    expect(rows[0]).toMatchObject({ typeFamily: 'TEXT', labelFields: ['region_libelle'] });
  });

  test('without a description the schema stays bare', async () => {
    const { table } = await roundTrip(SQL);

    expect(table.schema.metadata.size).toBe(0);
    expect(table.schema.fields.every((f) => f.metadata.size === 0)).toBe(true);
  });

  test('an empty result still carries its metadata', async () => {
    const { table } = await roundTrip(`${SQL} WHERE false`, DESCRIPTION);

    expect(table.numRows).toBe(0);
    expect(table.schema.metadata.has('database.dataset')).toBe(true);
    expect(table.schema.fields[0].metadata.get('label')).toBe('Région');
  });
});
