// Reprise d'un export au-delà de MAX_ROWS : ordre total et curseur par clé
import type { SortItem } from '../loaders/base-loader.js';
import { ALL_COLUMNS_FIELD } from '../utils/default-sort.js';
import { quoteIdent } from '../utils/identifiers.js';
import { ExportHttpError } from './export-params.js';

/**
 * Keyset pagination of the export.
 *
 * A truncated export carries `X-Next-After`, the sort key of its last row; the
 * next request passes it back as `after` and receives the rows strictly after
 * that key. Each page costs one filtered scan plus a top-n sort, whatever its
 * rank — unlike an offset, whose sort grows with the pages already read.
 *
 * Reliability rests on four points:
 * - the order is TOTAL: resolveEffectiveSort is completed with the primary
 *   keys or, without any, with every column of the table (unique rows are the
 *   writer's contract, the one GraphQL's ORDER BY ALL already relies on).
 *   `ORDER BY ALL` itself is spelled out, since it only covers the projected
 *   columns and would change with `fields`;
 * - NULLs, frequent in hierarchy columns, sort last (explicit `NULLS LAST`)
 *   and the predicate is expanded column by column with IS NOT DISTINCT FROM,
 *   a row-value comparison yielding NULL as soon as one member is NULL;
 * - key values travel as the text of `CAST(col AS VARCHAR)` and are bound as
 *   VARCHAR: DuckDB types each parameter after the column it is compared
 *   with, which round-trips DECIMAL, DATE, TIME, TIMESTAMP, DOUBLE, HUGEINT
 *   and LIST values exactly;
 * - the token names the order it was issued for, and is refused under
 *   another one.
 */

/** One column of the total order of an export. */
type KeyColumn = SortItem;

/** Parameterized SQL fragment. */
interface SqlFragment {
  sql: string;
  params: unknown[];
}

/** Decoded `after` token. */
interface ExportCursor {
  /** Order the cursor was issued for, as [column, direction] pairs. */
  order: [string, SortItem['order']][];
  /** Key of the last row sent, as DuckDB text; null for a NULL value. */
  values: (string | null)[];
}

/**
 * Builds a 400 error for an invalid `after` cursor.
 *
 * @param detail - Human-readable cause.
 * @returns The error to throw.
 */
const badCursor = (detail: string): ExportHttpError =>
  new ExportHttpError(400, 'Invalid export parameter', `Invalid "after" cursor: ${detail}`);

// ─── Ordre total ─────────────────────────────────────────────────────────────

/**
 * Completes an effective sort into a total order over the fact table.
 *
 * `ORDER BY ALL` becomes every column of the table in table order (the order
 * it produced without projection); any other sort gets the primary keys it
 * does not name yet or, without primary key, every other column.
 *
 * @param sort - Effective sort (resolveEffectiveSort).
 * @param columns - Every column of the fact table, in table order.
 * @param primaryKeys - Primary key columns.
 * @returns The key columns, without duplicates.
 */
function completeTotalOrder(
  sort: SortItem[],
  columns: string[],
  primaryKeys: string[],
): KeyColumn[] {
  const explicit = sort.filter((item) => item.field !== ALL_COLUMNS_FIELD);
  const named = new Set(explicit.map((item) => item.field));
  const tiebreakers = (primaryKeys.length > 0 ? primaryKeys : columns)
    .filter((field) => !named.has(field))
    .map((field) => ({ field, order: 'ASC' as const }));
  return [...explicit, ...tiebreakers];
}

/**
 * Renders the ORDER BY of a total order, NULLs last in both directions.
 *
 * @param order - Key columns.
 * @returns The ORDER BY clause.
 */
function buildOrderBy(order: KeyColumn[]): string {
  return `ORDER BY ${order.map((k) => `${quoteIdent(k.field)} ${k.order} NULLS LAST`).join(', ')}`;
}

// ─── Prédicat de reprise ─────────────────────────────────────────────────────

/**
 * Builds the predicate selecting the rows strictly after a key.
 *
 * Expanded as OR_i (c_1 = v_1 AND … AND c_{i-1} = v_{i-1} AND c_i after v_i),
 * equalities being NULL-safe. With NULLs last, "c after v" is
 * `c > v OR c IS NULL` (ASC) or `c < v OR c IS NULL` (DESC), and nothing comes
 * after a NULL.
 *
 * @param order - Key columns.
 * @param values - Key of the last row sent, aligned with order.
 * @returns The predicate and its parameters.
 */
function buildAfterPredicate(order: KeyColumn[], values: (string | null)[]): SqlFragment {
  const terms: string[] = [];
  const params: unknown[] = [];
  order.forEach((key, i) => {
    // Rien ne suit NULL (NULLS LAST) : terme toujours faux, omis
    if (values[i] === null) return;
    const parts: string[] = [];
    for (let j = 0; j < i; j++) {
      parts.push(`${quoteIdent(order[j].field)} IS NOT DISTINCT FROM ?`);
      params.push(values[j]);
    }
    const column = quoteIdent(key.field);
    parts.push(`(${column} ${key.order === 'DESC' ? '<' : '>'} ? OR ${column} IS NULL)`);
    params.push(values[i]);
    terms.push(parts.join(' AND '));
  });
  return { sql: terms.length > 0 ? terms.map((t) => `(${t})`).join(' OR ') : 'FALSE', params };
}

// ─── Jeton ───────────────────────────────────────────────────────────────────

/**
 * Encodes the cursor of the last row sent.
 *
 * base64url of a JSON document: ASCII, so valid in an HTTP header whatever
 * the labels it carries, and usable as is in a query string or a JSON body.
 *
 * @param order - Key columns.
 * @param values - Key of the last row sent, as DuckDB text.
 * @returns The opaque token.
 */
function encodeCursor(order: KeyColumn[], values: (string | null)[]): string {
  const document = { s: order.map((k) => [k.field, k.order]), k: values };
  return Buffer.from(JSON.stringify(document), 'utf8').toString('base64url');
}

/**
 * Decodes an `after` token and checks its shape.
 *
 * @param token - Value of the `after` parameter.
 * @returns The decoded cursor.
 * @throws {ExportHttpError} 400 when the token is not one this API issued.
 */
function decodeCursor(token: string): ExportCursor {
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw badCursor('pass the X-Next-After header of the previous page unchanged.');
  }
  const { s, k } = (document ?? {}) as { s?: unknown; k?: unknown };
  const validOrder =
    Array.isArray(s) &&
    s.length > 0 &&
    s.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        (pair[1] === 'ASC' || pair[1] === 'DESC'),
    );
  const validValues =
    Array.isArray(k) && k.every((value) => value === null || typeof value === 'string');
  if (!validOrder || !validValues || k.length !== s.length) {
    throw badCursor('pass the X-Next-After header of the previous page unchanged.');
  }
  return { order: s as ExportCursor['order'], values: k as ExportCursor['values'] };
}

/**
 * Checks that a cursor was issued for the order of the current request.
 *
 * @param cursor - Decoded cursor.
 * @param order - Total order of the current request.
 * @throws {ExportHttpError} 400 when the orders differ (other schema or sort).
 */
function assertCursorOrder(cursor: ExportCursor, order: KeyColumn[]): void {
  const matches =
    cursor.order.length === order.length &&
    cursor.order.every(([field, dir], i) => field === order[i].field && dir === order[i].order);
  if (!matches) {
    throw badCursor(
      'it was issued for another sort or schema; resume with the parameters of the first page.',
    );
  }
}

export {
  assertCursorOrder,
  buildAfterPredicate,
  buildOrderBy,
  completeTotalOrder,
  decodeCursor,
  encodeCursor,
};
export type { ExportCursor, KeyColumn, SqlFragment };
