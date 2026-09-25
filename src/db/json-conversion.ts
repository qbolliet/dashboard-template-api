// Importation des modules
import { DuckDBTimestampValue, DuckDBTypeId, JsonDuckDBValueConverter } from '@duckdb/node-api';
import { sqlTypeFamily } from '../utils/filter-tree.js';
import type {
  DuckDBType,
  DuckDBValue,
  DuckDBValueConverter,
  Json,
  DuckDBDateValue,
  DuckDBDecimalValue,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBTimestampSecondsValue,
  DuckDBTimestampTZValue,
} from '@duckdb/node-api';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Min/max of one column of a page: numbers for numeric columns, ISO strings for temporal ones. */
export type ColumnExtent = [number, number] | [string, string];

// ─── Constantes ───────────────────────────────────────────────────────────────

// Bornes des entiers exactement représentables par un nombre JSON (Number.isSafeInteger)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

// Précision maximale nécessaire pour restituer un FLOAT (32 bits) sans perte
const FLOAT_MAX_DIGITS = 9;

// ─── Convertisseurs par type ──────────────────────────────────────────────────

/**
 * Converts a DuckDB integer to a JSON value.
 *
 * An integer inside the safe range of a JSON number becomes a number, anything
 * beyond becomes its exact decimal string: the client can tell the two apart
 * and never receives a silently rounded value.
 *
 * @param value - Integer as returned by DuckDB (bigint for the 64/128-bit types).
 * @returns A number when safe, its decimal string otherwise.
 */
// Entier sûr → nombre, sinon chaîne décimale exacte
function jsonFromInteger(value: DuckDBValue): Json {
  const integer = typeof value === 'bigint' ? value : BigInt(value as number);
  return integer >= MIN_SAFE && integer <= MAX_SAFE ? Number(integer) : integer.toString();
}

/**
 * Converts a DOUBLE to a JSON number; non-finite values have no JSON form.
 *
 * @param value - Double as returned by DuckDB.
 * @returns The number, or null for NaN and ±Infinity.
 */
// DOUBLE → nombre, NaN / ±Infinity → null
function jsonFromDouble(value: DuckDBValue): Json {
  const number = value as number;
  return Number.isFinite(number) ? number : null;
}

/**
 * Converts a FLOAT (32 bits) to a JSON number.
 *
 * DuckDB hands the value over widened to a double, so 0.1f arrives as
 * 0.10000000149011612. The shortest decimal that still rounds to the same
 * 32-bit float is returned instead (0.1).
 *
 * @param value - Float as returned by DuckDB.
 * @returns The shortest faithful number, or null for NaN and ±Infinity.
 */
// FLOAT → plus court décimal qui restitue le même flottant 32 bits
function jsonFromFloat(value: DuckDBValue): Json {
  const number = value as number;
  if (!Number.isFinite(number)) return null;
  for (let digits = 1; digits <= FLOAT_MAX_DIGITS; digits++) {
    const candidate = Number(number.toPrecision(digits));
    if (Math.fround(candidate) === number) return candidate;
  }
  return number;
}

/**
 * Converts a DECIMAL to a JSON number.
 *
 * @param value - Decimal as returned by DuckDB.
 * @returns The value as a double.
 */
// DECIMAL → nombre
function jsonFromDecimal(value: DuckDBValue): Json {
  return jsonFromDouble((value as DuckDBDecimalValue).toDouble());
}

/**
 * Converts a DATE to `YYYY-MM-DD`.
 *
 * @param value - Date as returned by DuckDB.
 * @returns The ISO date, or null for the infinite dates (no ISO form).
 */
// DATE → "YYYY-MM-DD"
function jsonFromDate(value: DuckDBValue): Json {
  const date = value as DuckDBDateValue;
  return date.isFinite ? date.toString() : null;
}

/**
 * Converts a zone-less TIMESTAMP (any precision) to ISO 8601 with a `T` separator.
 *
 * @param value - Timestamp as returned by DuckDB.
 * @returns `YYYY-MM-DDTHH:mm:ss[.fff]`, or null for the infinite timestamps.
 */
// TIMESTAMP sans fuseau → ISO 8601 avec séparateur T
function jsonFromTimestamp(value: DuckDBValue): Json {
  const timestamp = value as
    | DuckDBTimestampMillisecondsValue
    | DuckDBTimestampNanosecondsValue
    | DuckDBTimestampSecondsValue
    | DuckDBTimestampValue;
  return timestamp.isFinite ? timestamp.toString().replace(' ', 'T') : null;
}

/**
 * Converts a TIMESTAMP WITH TIME ZONE to ISO 8601 in UTC, `Z` suffix included.
 *
 * DuckDB renders these values in the session's time zone; rebuilding a naive
 * timestamp from the stored UTC microseconds makes the output independent of it.
 *
 * @param value - Timestamp with time zone as returned by DuckDB.
 * @returns `YYYY-MM-DDTHH:mm:ss[.ffffff]Z`, or null for the infinite timestamps.
 */
// TIMESTAMP avec fuseau → ISO 8601 en UTC, suffixe Z
function jsonFromTimestampTz(value: DuckDBValue): Json {
  const timestamp = value as DuckDBTimestampTZValue;
  if (!timestamp.isFinite) return null;
  return `${new DuckDBTimestampValue(timestamp.micros).toString().replace(' ', 'T')}Z`;
}

// Types dont la sérialisation diffère de celle de DuckDB ; les autres, dont les
// types imbriqués (LIST, STRUCT…), passent par le convertisseur JSON du paquet.
const CONVERTERS_BY_TYPE_ID: Partial<Record<DuckDBTypeId, (value: DuckDBValue) => Json>> = {
  [DuckDBTypeId.BIGINT]: jsonFromInteger,
  [DuckDBTypeId.UBIGINT]: jsonFromInteger,
  [DuckDBTypeId.HUGEINT]: jsonFromInteger,
  [DuckDBTypeId.UHUGEINT]: jsonFromInteger,
  [DuckDBTypeId.DECIMAL]: jsonFromDecimal,
  [DuckDBTypeId.FLOAT]: jsonFromFloat,
  [DuckDBTypeId.DOUBLE]: jsonFromDouble,
  [DuckDBTypeId.DATE]: jsonFromDate,
  [DuckDBTypeId.TIMESTAMP]: jsonFromTimestamp,
  [DuckDBTypeId.TIMESTAMP_S]: jsonFromTimestamp,
  [DuckDBTypeId.TIMESTAMP_MS]: jsonFromTimestamp,
  [DuckDBTypeId.TIMESTAMP_NS]: jsonFromTimestamp,
  [DuckDBTypeId.TIMESTAMP_TZ]: jsonFromTimestampTz,
};

/**
 * The single DuckDB → JSON value converter of the API.
 *
 * Every JSON read path of the pool (`all`, `getAsJsonArray`,
 * `getWithMetadata`) goes through it, so OBJECTS, ARRAYS, the fact queries,
 * the aggregates and the comparisons share one serialization contract. It is
 * driven by the DuckDB column type, never by `typeof` on the value:
 *
 * - integers within `Number.isSafeInteger` → JSON number, beyond → decimal string;
 * - DECIMAL → number; FLOAT / DOUBLE → number (NaN, ±Infinity → null);
 * - DATE → `YYYY-MM-DD`;
 * - TIMESTAMP → `YYYY-MM-DDTHH:mm:ss[.fff]`, plus a `Z` suffix (UTC) for the
 *   types carrying a time zone;
 * - BOOLEAN → boolean; NULL → null; the other types as the package serializes them.
 *
 * @param value - Value as returned by DuckDB.
 * @param type - DuckDB column type of the value.
 * @param converter - Converter to apply to nested values.
 * @returns The JSON form of the value.
 */
// Convertisseur unique appliqué à tous les chemins JSON du pool
const jsonValueConverter: DuckDBValueConverter<Json> = (value, type, converter) => {
  if (value === null || value === undefined) return null;
  const convert = CONVERTERS_BY_TYPE_ID[type.typeId];
  return convert ? convert(value) : JsonDuckDBValueConverter(value, type, converter);
};

// ─── Extents de page ──────────────────────────────────────────────────────────

/**
 * Sort key of an ISO 8601 timestamp string: the fraction padded to nanoseconds
 * and the `Z` suffix dropped, so that plain string comparison is chronological
 * (`…12Z` < `…12.5Z` would otherwise be reversed by the `Z`).
 *
 * @param iso - Serialized DATE or TIMESTAMP.
 * @returns A string whose lexicographic order is the chronological order.
 */
// Clé de comparaison chronologique d'une date ISO
function chronologicalKey(iso: string): string {
  const [main, fraction = ''] = iso.replace(/Z$/, '').split('.');
  return `${main}.${fraction.padEnd(9, '0')}`;
}

/**
 * Computes the min/max of the numeric and temporal columns of a page.
 *
 * The family of each column comes from its DuckDB type through
 * {@link sqlTypeFamily}. Integers beyond 2^53, serialized as strings, take part
 * as numbers, so their bound is approximate at that magnitude. NULLs are
 * ignored; a column with no value gets no entry.
 *
 * @param columnNames - Column names of the result.
 * @param columnTypes - DuckDB types of the columns, same order.
 * @param rows - Rows already converted by {@link jsonValueConverter}.
 * @returns Extent per column: `[number, number]` or ISO `[string, string]`.
 */
// Extents numériques et temporels d'une page de résultats
function computeExtents(
  columnNames: string[],
  columnTypes: DuckDBType[],
  rows: Record<string, Json>[],
): Record<string, ColumnExtent> {
  // Initialisation de la collection résultat
  const extents: Record<string, ColumnExtent> = {};
  // Parcours des colonnes
  columnNames.forEach((name, index) => {
    // Identification de la famille de type
    let family: string;
    try {
      family = sqlTypeFamily(columnTypes[index].toString());
    } catch {
      // Type sans famille reconnue (LIST, BLOB…) : pas d'extent
      return;
    }

    // Cas numérique
    if (family === 'numeric') {
      // Initialisation du minimum et du maximum
      let min = Infinity;
      let max = -Infinity;
      // Mise à jour
      for (const row of rows) {
        const value = Number(row[name]);
        if (row[name] === null || row[name] === undefined || !Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (min <= max) extents[name] = [min, max];
      // Cas d'une date
    } else if (family === 'date') {
      // Initlisation du minimum et du maximum
      let min: string | null = null;
      let max: string | null = null;
      let minKey = '';
      let maxKey = '';
      // Mise à jour
      for (const row of rows) {
        const value = row[name];
        if (typeof value !== 'string') continue;
        const key = chronologicalKey(value);
        if (min === null || key < minKey) {
          min = value;
          minKey = key;
        }
        if (max === null || key > maxKey) {
          max = value;
          maxKey = key;
        }
      }
      if (min !== null && max !== null) extents[name] = [min, max];
    }
  });

  return extents;
}

export { jsonValueConverter, computeExtents };
