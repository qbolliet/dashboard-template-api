// Importation des modules
import {
  Bool,
  DataType,
  DateDay,
  Decimal,
  Field,
  Float32,
  Float64,
  Int16,
  Int32,
  Int64,
  Int8,
  RecordBatch,
  Schema,
  Struct,
  TimeUnit,
  Timestamp,
  Uint16,
  Uint32,
  Uint64,
  Uint8,
  Utf8,
  makeData,
} from 'apache-arrow';
import type { Data } from 'apache-arrow';
import { DuckDBTypeId } from '@duckdb/node-api';
import type {
  DuckDBDataChunk,
  DuckDBDateValue,
  DuckDBDecimalType,
  DuckDBDecimalValue,
  DuckDBType,
  DuckDBVector,
} from '@duckdb/node-api';

// ─── Correspondance des types DuckDB → Arrow ─────────────────────────────────

/**
 * Conversion of DuckDB result chunks into Arrow record batches.
 *
 * @duckdb/node-api has no Arrow export of its own (checked on 1.5.2-r.2), and
 * the typed arrays backing its vectors are private: values are read through
 * the public `getItem` accessor and packed into the Arrow buffers directly —
 * no generic Arrow builder — so each column costs one pass over the chunk.
 *
 * Every type of the database specification keeps its exact type (UBIGINT
 * stays Uint64, FLOAT stays Float32, TIMESTAMP stays a microsecond timestamp).
 * Types outside the specification (HUGEINT, LIST, STRUCT, INTERVAL…) are
 * written as Utf8 through their string form.
 */

/** How the values of one column are packed into an Arrow buffer. */
type ColumnKind = 'int' | 'bigint' | 'float' | 'bool' | 'date' | 'timestamp' | 'decimal' | 'utf8';

/** Arrow type of one column plus the way its values are packed. */
interface ColumnPlan {
  type: DataType;
  kind: ColumnKind;
  /** Name of the bigint field of a timestamp value (micros, millis…). */
  timestampField?: 'micros' | 'millis' | 'seconds' | 'nanos';
}

/** Arrow schema of an export plus the packing plan of each column. */
interface ArrowExportLayout {
  schema: Schema;
  plans: ColumnPlan[];
}

/**
 * Chooses the Arrow type and the packing of one DuckDB column type.
 *
 * @param duckType - DuckDB type of the column.
 * @returns The packing plan of the column.
 */
// Type Arrow retenu pour un type DuckDB (repli Utf8 hors spécification)
function planColumn(duckType: DuckDBType): ColumnPlan {
  switch (duckType.typeId) {
    case DuckDBTypeId.BOOLEAN:
      return { type: new Bool(), kind: 'bool' };
    case DuckDBTypeId.TINYINT:
      return { type: new Int8(), kind: 'int' };
    case DuckDBTypeId.SMALLINT:
      return { type: new Int16(), kind: 'int' };
    case DuckDBTypeId.INTEGER:
      return { type: new Int32(), kind: 'int' };
    case DuckDBTypeId.BIGINT:
      return { type: new Int64(), kind: 'bigint' };
    case DuckDBTypeId.UTINYINT:
      return { type: new Uint8(), kind: 'int' };
    case DuckDBTypeId.USMALLINT:
      return { type: new Uint16(), kind: 'int' };
    case DuckDBTypeId.UINTEGER:
      return { type: new Uint32(), kind: 'int' };
    case DuckDBTypeId.UBIGINT:
      return { type: new Uint64(), kind: 'bigint' };
    case DuckDBTypeId.FLOAT:
      return { type: new Float32(), kind: 'float' };
    case DuckDBTypeId.DOUBLE:
      return { type: new Float64(), kind: 'float' };
    case DuckDBTypeId.DECIMAL: {
      const { width, scale } = duckType as DuckDBDecimalType;
      return { type: new Decimal(scale, width, 128), kind: 'decimal' };
    }
    case DuckDBTypeId.DATE:
      return { type: new DateDay(), kind: 'date' };
    case DuckDBTypeId.TIMESTAMP:
      return {
        type: new Timestamp(TimeUnit.MICROSECOND),
        kind: 'timestamp',
        timestampField: 'micros',
      };
    case DuckDBTypeId.TIMESTAMP_S:
      return {
        type: new Timestamp(TimeUnit.SECOND),
        kind: 'timestamp',
        timestampField: 'seconds',
      };
    case DuckDBTypeId.TIMESTAMP_MS:
      return {
        type: new Timestamp(TimeUnit.MILLISECOND),
        kind: 'timestamp',
        timestampField: 'millis',
      };
    case DuckDBTypeId.TIMESTAMP_NS:
      return {
        type: new Timestamp(TimeUnit.NANOSECOND),
        kind: 'timestamp',
        timestampField: 'nanos',
      };
    case DuckDBTypeId.TIMESTAMP_TZ:
      return {
        type: new Timestamp(TimeUnit.MICROSECOND, 'UTC'),
        kind: 'timestamp',
        timestampField: 'micros',
      };
    default:
      // VARCHAR, ENUM et tout type hors spécification : forme texte
      return { type: new Utf8(), kind: 'utf8' };
  }
}

/**
 * Builds the Arrow schema of an export from the DuckDB result columns.
 *
 * Every field is nullable: the fact table declares no NOT NULL constraint
 * the API could rely on.
 *
 * @param names - Column names of the DuckDB result.
 * @param types - Column types of the DuckDB result, aligned with names.
 * @returns The Arrow schema and the packing plan of each column.
 */
function buildArrowLayout(
  names: readonly string[],
  types: readonly DuckDBType[],
): ArrowExportLayout {
  const plans = types.map(planColumn);
  const fields = names.map((name, i) => new Field(name, plans[i].type, true));
  return { schema: new Schema(fields), plans };
}

// ─── Remplissage des buffers ─────────────────────────────────────────────────

/** Validity bitmap of a column: bit set = value present. */
interface Validity {
  bitmap: Uint8Array;
  nullCount: number;
}

/**
 * Reads every item of a vector, recording the nulls in a validity bitmap.
 *
 * @param vector - DuckDB vector of the column.
 * @param length - Number of rows of the chunk.
 * @param onValue - Receives each non-null value and its row index.
 * @returns The validity bitmap and the null count.
 */
// Parcours unique d'un vecteur : bitmap de validité + rappel par valeur présente
function scanVector(
  vector: DuckDBVector,
  length: number,
  onValue: (value: unknown, index: number) => void,
): Validity {
  const bitmap = new Uint8Array(Math.ceil(length / 8));
  let nullCount = 0;
  for (let i = 0; i < length; i++) {
    const value = vector.getItem(i);
    if (value === null || value === undefined) {
      nullCount++;
    } else {
      bitmap[i >> 3] |= 1 << (i & 7);
      onValue(value, i);
    }
  }
  return { bitmap, nullCount };
}

/**
 * Writes a DECIMAL value as the four little-endian 32-bit words of an Arrow
 * Decimal128 (two's complement).
 *
 * @param words - Destination buffer (4 words per row).
 * @param index - Row index.
 * @param scaled - Scaled-up integer value of the decimal.
 */
// Entier 128 bits en complément à deux, mots de poids faible en premier
function writeDecimal128(words: Uint32Array, index: number, scaled: bigint): void {
  let unsigned = BigInt.asUintN(128, scaled);
  for (let w = 0; w < 4; w++) {
    words[index * 4 + w] = Number(unsigned & 0xffffffffn);
    unsigned >>= 32n;
  }
}

/**
 * Packs the Utf8 column of a chunk into Arrow offsets and bytes.
 *
 * @param vector - DuckDB vector of the column.
 * @param length - Number of rows of the chunk.
 * @param type - Arrow Utf8 type.
 * @returns The Arrow data of the column.
 */
// Colonne texte : encodage UTF-8 de chaque valeur puis concaténation
function packUtf8(vector: DuckDBVector, length: number, type: DataType): Data {
  const encoded: Buffer[] = new Array(length);
  const valueOffsets = new Int32Array(length + 1);
  let total = 0;
  const validity = scanVector(vector, length, (value, i) => {
    encoded[i] = Buffer.from(typeof value === 'string' ? value : String(value), 'utf8');
  });
  for (let i = 0; i < length; i++) {
    total += encoded[i]?.length ?? 0;
    valueOffsets[i + 1] = total;
  }
  const bytes = new Uint8Array(total);
  for (let i = 0; i < length; i++) {
    if (encoded[i]) bytes.set(encoded[i], valueOffsets[i]);
  }
  return makeData({
    type: type as Utf8,
    length,
    nullCount: validity.nullCount,
    nullBitmap: validity.nullCount > 0 ? validity.bitmap : undefined,
    valueOffsets,
    data: bytes,
  });
}

/**
 * Packs one column of a DuckDB chunk into Arrow data.
 *
 * @param vector - DuckDB vector of the column.
 * @param length - Number of rows of the chunk.
 * @param plan - Packing plan of the column.
 * @returns The Arrow data of the column.
 */
// Construction des buffers Arrow d'une colonne selon son plan
function packColumn(vector: DuckDBVector, length: number, plan: ColumnPlan): Data {
  if (plan.kind === 'utf8') return packUtf8(vector, length, plan.type);

  let data: ArrayLike<unknown> & object;
  let onValue: (value: unknown, index: number) => void;

  switch (plan.kind) {
    case 'bool': {
      const bits = new Uint8Array(Math.ceil(length / 8));
      data = bits;
      onValue = (value, i) => {
        if (value === true) bits[i >> 3] |= 1 << (i & 7);
      };
      break;
    }
    case 'int':
    case 'float':
    case 'bigint': {
      const ArrayType = (plan.type as unknown as { ArrayType: new (n: number) => unknown[] })
        .ArrayType;
      const values = new ArrayType(length);
      data = values;
      onValue = (value, i) => {
        values[i] = value;
      };
      break;
    }
    case 'date': {
      const days = new Int32Array(length);
      data = days;
      onValue = (value, i) => {
        days[i] = (value as DuckDBDateValue).days;
      };
      break;
    }
    case 'timestamp': {
      const ticks = new BigInt64Array(length);
      const field = plan.timestampField ?? 'micros';
      data = ticks;
      onValue = (value, i) => {
        ticks[i] = (value as Record<string, bigint>)[field];
      };
      break;
    }
    case 'decimal': {
      const words = new Uint32Array(length * 4);
      data = words;
      onValue = (value, i) => writeDecimal128(words, i, (value as DuckDBDecimalValue).value);
      break;
    }
  }

  const validity = scanVector(vector, length, onValue);
  // makeData est surchargé par famille de type : le plan garantit la cohérence
  // entre le type Arrow et le buffer construit ci-dessus
  return makeData({
    type: plan.type,
    length,
    nullCount: validity.nullCount,
    nullBitmap: validity.nullCount > 0 ? validity.bitmap : undefined,
    data,
  } as unknown as Parameters<typeof makeData>[0]);
}

/**
 * Converts one DuckDB data chunk into an Arrow record batch.
 *
 * @param chunk - Chunk read from a DuckDB result.
 * @param layout - Arrow schema and packing plans of the export.
 * @returns A record batch holding the rows of the chunk.
 */
function chunkToRecordBatch(chunk: DuckDBDataChunk, layout: ArrowExportLayout): RecordBatch {
  const length = chunk.rowCount;
  const children = layout.plans.map((plan, col) =>
    packColumn(chunk.getColumnVector(col), length, plan),
  );
  return buildBatch(layout.schema, length, children);
}

/**
 * Builds an empty record batch, so that an export without rows still carries
 * its schema.
 *
 * @param layout - Arrow schema and packing plans of the export.
 * @returns A zero-row record batch.
 */
function emptyRecordBatch(layout: ArrowExportLayout): RecordBatch {
  const children = layout.schema.fields.map((field) =>
    makeData({
      type: field.type,
      length: 0,
      nullCount: 0,
      ...(field.type instanceof Utf8 ? { valueOffsets: new Int32Array(1) } : {}),
    } as unknown as Parameters<typeof makeData>[0]),
  );
  return buildBatch(layout.schema, 0, children);
}

/**
 * Assembles column data into a record batch of the given schema.
 *
 * @param schema - Arrow schema of the batch.
 * @param length - Number of rows.
 * @param children - Arrow data of each column, in schema order.
 * @returns The record batch.
 */
// Enveloppe Struct attendue par le constructeur de RecordBatch
function buildBatch(schema: Schema, length: number, children: Data[]): RecordBatch {
  const struct = makeData({
    type: new Struct(schema.fields),
    length,
    nullCount: 0,
    children,
  });
  return new RecordBatch(schema, struct);
}

export { buildArrowLayout, chunkToRecordBatch, emptyRecordBatch, writeDecimal128 };
export type { ArrowExportLayout, ColumnPlan };
