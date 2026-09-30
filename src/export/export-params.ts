// Importation des modules
import os from 'os';
import path from 'path';
import { config } from '../utils/config-loader.js';
import type { ExportConfig } from '../utils/config-loader.js';
import type { SortItem } from '../loaders/base-loader.js';
import type { FilterNodeInput } from '../utils/filter-tree.js';

// ─── Formats d'export ────────────────────────────────────────────────────────

/** Export formats accepted by /api/export. */
const EXPORT_FORMATS = ['arrow', 'csv', 'parquet'] as const;

/** Export format (value of the `format` query parameter). */
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** HTTP representation of each format. */
const FORMAT_SPECS: Record<ExportFormat, { contentType: string; extension: string }> = {
  // Flux IPC Arrow : extension .arrows (format « stream », pas « file »)
  arrow: { contentType: 'application/vnd.apache.arrow.stream', extension: 'arrows' },
  csv: { contentType: 'text/csv; charset=utf-8', extension: 'csv' },
  parquet: { contentType: 'application/vnd.apache.parquet', extension: 'parquet' },
};

// ─── Réglages ────────────────────────────────────────────────────────────────

/** Resolved guards of the export endpoint. */
interface ExportSettings {
  maxRows: number;
  maxConcurrentPerIp: number;
  maxConcurrentTotal: number;
  timeoutMs: number;
  tmpDir: string;
}

// Valeurs par défaut, identiques à config/api.yaml
const DEFAULT_SETTINGS: Omit<ExportSettings, 'tmpDir'> = {
  maxRows: 5_000_000,
  maxConcurrentPerIp: 2,
  maxConcurrentTotal: 2,
  timeoutMs: 120_000,
};

/**
 * Coerces a configuration value into a positive integer.
 *
 * @param raw - Value read from the configuration (number or env string).
 * @param fallback - Value used when raw is missing or invalid.
 * @returns A positive integer.
 */
// Entier strictement positif, tolérant à la forme chaîne des variables d'env
function positiveInt(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Reads the EXPORT section of the API configuration.
 *
 * @param raw - EXPORT section; defaults to the loaded configuration.
 * @returns Resolved settings, with defaults for missing or invalid entries.
 */
function loadExportSettings(raw: ExportConfig | undefined = config.API.EXPORT): ExportSettings {
  const tmpDir = typeof raw?.TMP_DIR === 'string' ? raw.TMP_DIR.trim() : '';
  return {
    maxRows: positiveInt(raw?.MAX_ROWS, DEFAULT_SETTINGS.maxRows),
    maxConcurrentPerIp: positiveInt(
      raw?.MAX_CONCURRENT_PER_IP,
      DEFAULT_SETTINGS.maxConcurrentPerIp,
    ),
    maxConcurrentTotal: positiveInt(raw?.MAX_CONCURRENT_TOTAL, DEFAULT_SETTINGS.maxConcurrentTotal),
    timeoutMs: positiveInt(raw?.TIMEOUT_MS, DEFAULT_SETTINGS.timeoutMs),
    tmpDir: tmpDir || path.join(os.tmpdir(), 'dashboard-api-export'),
  };
}

// ─── Erreurs HTTP ────────────────────────────────────────────────────────────

/** Error carrying the HTTP status and JSON body of an export refusal. */
class ExportHttpError extends Error {
  /**
   * Creates an export error.
   *
   * @param status - HTTP status code of the response.
   * @param error - Short error label (`error` field of the JSON body).
   * @param detail - Human-readable cause (`detail` field of the JSON body).
   */
  constructor(
    readonly status: number,
    readonly error: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ExportHttpError';
  }
}

/**
 * Builds a 400 error for an invalid query parameter.
 *
 * @param detail - Human-readable cause.
 * @returns The error to throw.
 */
const badParameter = (detail: string): ExportHttpError =>
  new ExportHttpError(400, 'Invalid export parameter', detail);

// ─── Paramètres de requête ───────────────────────────────────────────────────

/** Where the parameters of an export come from: query string (GET) or JSON body (POST). */
type ExportParamSource = 'query' | 'body';

/** Validated parameters of an export request. */
interface ExportParams {
  catalog: string | null;
  schema: string | null;
  /** Projected columns; null exports every column. */
  fields: string[] | null;
  /** Filter tree, structurally parsed; compiled later against the metadata. */
  filters: FilterNodeInput | null;
  /** Explicit sort; null falls back to cluster_by. */
  sort: SortItem[] | null;
  format: ExportFormat;
  /** Row ceiling actually applied (never above settings.maxRows). */
  limit: number;
  /** Whether the client gave `limit`: beyond the ceiling, 413 without it, X-Truncated with it. */
  explicitLimit: boolean;
  /** Resume cursor (X-Next-After of the previous page), decoded once the order is known. */
  after: string | null;
}

// Paramètres reconnus : tout autre nom est refusé (une faute de frappe sur
// « filters » exporterait silencieusement toute la table)
const KNOWN_PARAMETERS = new Set([
  'catalog',
  'schema',
  'fields',
  'filters',
  'sort',
  'format',
  'limit',
  'after',
]);

/**
 * Reads one parameter as a single optional string.
 *
 * @param input - Parsed query string or JSON body.
 * @param name - Parameter name.
 * @returns The trimmed value, or null when absent or empty.
 * @throws {ExportHttpError} 400 when the parameter is repeated or structured.
 */
function readString(input: Record<string, unknown>, name: string): string | null {
  const value = input[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw badParameter(`Parameter "${name}" must be given once, as a plain string.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads a list parameter: a comma-separated string or, in a JSON body, an
 * array of strings (which lets a column name contain a comma).
 *
 * @param input - Parsed query string or JSON body.
 * @param name - Parameter name.
 * @param source - Origin of the parameters.
 * @returns The trimmed items, or null when absent or empty.
 * @throws {ExportHttpError} 400 on a value of the wrong shape.
 */
function readList(
  input: Record<string, unknown>,
  name: string,
  source: ExportParamSource,
): string[] | null {
  const value = input[name];
  if (source === 'body' && Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) {
      throw badParameter(`Parameter "${name}" must be an array of strings.`);
    }
    return value.length === 0 ? null : value.map((item: string) => item.trim());
  }
  const raw = readString(input, name);
  return raw === null ? null : raw.split(',').map((item) => item.trim());
}

/**
 * Checks that a column name is not empty.
 *
 * Any column name the database accepts is allowed — it is quoted in the SQL
 * and checked against the metadata table once it is loaded.
 *
 * @param name - Candidate column name, already trimmed.
 * @param context - Label used in the error message.
 * @returns The column name, unchanged.
 * @throws {ExportHttpError} 400 when the name is empty.
 */
function columnName(name: string, context: string): string {
  if (name === '') throw badParameter(`Empty ${context} name.`);
  return name;
}

/**
 * Parses the `sort` items (`"col"` or `"col:asc|desc"`, direction optional).
 *
 * @param items - Sort items, already split (`"col:asc,col2:desc"` in a query string).
 * @returns Sort items, in the given order.
 * @throws {ExportHttpError} 400 on an invalid column, direction or duplicate.
 */
function parseSort(items: string[]): SortItem[] {
  const seen = new Set<string>();
  return items.map((item) => {
    const [column, direction, ...rest] = item.split(':').map((s) => s.trim());
    if (rest.length > 0 || !column) {
      throw badParameter(`Invalid sort item "${item}": expected "column" or "column:asc|desc".`);
    }
    const field = columnName(column, 'sort field');
    if (seen.has(field)) throw badParameter(`Sort column "${field}" is given twice.`);
    seen.add(field);

    const order = (direction || 'asc').toUpperCase();
    if (order !== 'ASC' && order !== 'DESC') {
      throw badParameter(`Invalid sort direction "${direction}": expected asc or desc.`);
    }
    return { field, order: order as SortItem['order'] };
  });
}

/**
 * Reads the `filters` parameter: the JSON of a FilterNode tree or, in a JSON
 * body, the tree itself.
 *
 * Only the JSON shape is checked here; structure, bounds (MAX_DEPTH,
 * MAX_CRITERIA), columns and values are validated by compileFilterTree, the
 * same path as the GraphQL `structuredFilters` argument.
 *
 * @param input - Parsed query string or JSON body.
 * @param source - Origin of the parameters.
 * @returns The filter tree, or null when absent.
 * @throws {ExportHttpError} 400 when the value is not a JSON object.
 */
function readFilters(
  input: Record<string, unknown>,
  source: ExportParamSource,
): FilterNodeInput | null {
  let parsed: unknown = input.filters;
  if (parsed === undefined || parsed === null) return null;

  // Chaîne JSON (query string, ou corps qui la transmet telle quelle)
  if (source === 'query' || typeof parsed === 'string') {
    const raw = readString(input, 'filters');
    if (raw === null) return null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw badParameter(`Parameter "filters" is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badParameter('Parameter "filters" must be the JSON object of a FilterNode.');
  }
  return parsed as FilterNodeInput;
}

/**
 * Reads the `limit` parameter: a digit string or, in a JSON body, a number.
 *
 * @param input - Parsed query string or JSON body.
 * @param source - Origin of the parameters.
 * @returns The requested row count, or null when absent.
 * @throws {ExportHttpError} 400 when it is not a positive integer.
 */
function readLimit(input: Record<string, unknown>, source: ExportParamSource): number | null {
  const value = input.limit;
  const raw =
    source === 'body' && typeof value === 'number' ? String(value) : readString(input, 'limit');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw badParameter(`Parameter "limit" must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

/**
 * Validates the parameters of an export request, whatever its transport.
 *
 * GET passes its query string, POST its JSON body: same names, rules and
 * errors, the body only accepting native JSON forms on top (arrays for
 * `fields` / `sort`, an object for `filters`, a number for `limit`).
 * Pure function: no database access. Column names only need to be non-empty
 * here; their existence in the schema is checked once the metadata is loaded,
 * and catalog/schema against their allow-lists (resolveExportTarget).
 *
 * @param input - Parsed query string (`req.query`) or JSON body (`req.body`).
 * @param settings - Export guards (row ceiling).
 * @param source - Origin of the parameters; the query string by default.
 * @returns The validated parameters.
 * @throws {ExportHttpError} 400 on any invalid parameter.
 */
function parseExportParams(
  input: Record<string, unknown>,
  settings: ExportSettings,
  source: ExportParamSource = 'query',
): ExportParams {
  const unknown = Object.keys(input).filter((name) => !KNOWN_PARAMETERS.has(name));
  if (unknown.length > 0) {
    throw badParameter(
      `Unknown parameter(s): ${unknown.join(', ')}. Accepted: ${[...KNOWN_PARAMETERS].join(', ')}.`,
    );
  }

  const catalogRaw = readString(input, 'catalog');
  const schemaRaw = readString(input, 'schema');

  // Format : liste blanche, arrow par défaut
  const formatRaw = (readString(input, 'format') ?? 'arrow').toLowerCase();
  if (!(EXPORT_FORMATS as readonly string[]).includes(formatRaw)) {
    throw badParameter(
      `Unknown format "${formatRaw}". Accepted formats: ${EXPORT_FORMATS.join(', ')}.`,
    );
  }

  // Colonnes projetées : noms non vides et sans doublon
  const fieldsRaw = readList(input, 'fields', source);
  let fields: string[] | null = null;
  if (fieldsRaw) {
    fields = fieldsRaw.map((f) => columnName(f, 'field'));
    const duplicate = fields.find((f, i) => fields!.indexOf(f) !== i);
    if (duplicate) throw badParameter(`Field "${duplicate}" is given twice.`);
  }

  // Plafond de lignes : jamais au-delà de MAX_ROWS ; au-delà, la route signale
  // la troncature (413 sans `limit`, X-Truncated avec)
  const requestedLimit = readLimit(input, source);
  const sortRaw = readList(input, 'sort', source);

  return {
    // Catalogue et schéma contrôlés contre leurs allow-lists par resolveExportTarget
    catalog: catalogRaw,
    schema: schemaRaw,
    fields,
    filters: readFilters(input, source),
    sort: sortRaw ? parseSort(sortRaw) : null,
    format: formatRaw as ExportFormat,
    limit: Math.min(requestedLimit ?? settings.maxRows, settings.maxRows),
    explicitLimit: requestedLimit !== null,
    after: readString(input, 'after'),
  };
}

export { EXPORT_FORMATS, FORMAT_SPECS, ExportHttpError, loadExportSettings, parseExportParams };
export type { ExportFormat, ExportParamSource, ExportParams, ExportSettings };
