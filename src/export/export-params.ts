// Importation des modules
import os from 'os';
import path from 'path';
import { config } from '../utils/config-loader.js';
import { validateIdentifier } from '../utils/utils.js';
import type { ExportConfig } from '../utils/config-loader.js';
import type { SortItem } from '../loaders/base-loader.js';
import type { FilterNodeInput } from '../utils/filter-tree.js';

// ─── Formats d'export ────────────────────────────────────────────────────────

/** Export formats accepted by GET /api/export. */
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
]);

/**
 * Reads one query parameter as a single optional string.
 *
 * @param query - Parsed query string.
 * @param name - Parameter name.
 * @returns The trimmed value, or null when absent or empty.
 * @throws {ExportHttpError} 400 when the parameter is repeated or structured.
 */
function readString(query: Record<string, unknown>, name: string): string | null {
  const value = query[name];
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw badParameter(`Parameter "${name}" must be given once, as a plain string.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Runs validateIdentifier and turns its GraphQL error into a 400.
 *
 * @param name - Candidate identifier.
 * @param context - Label used in the error message.
 * @returns The validated identifier.
 * @throws {ExportHttpError} 400 when the identifier is invalid.
 */
function identifier(name: string, context: string): string {
  try {
    return validateIdentifier(name, context);
  } catch (error) {
    throw badParameter((error as Error).message);
  }
}

/**
 * Parses the `sort` parameter (`"col:asc,col2:desc"`, direction optional).
 *
 * @param raw - Raw parameter value.
 * @returns Sort items, in the given order.
 * @throws {ExportHttpError} 400 on an invalid column, direction or duplicate.
 */
function parseSort(raw: string): SortItem[] {
  const seen = new Set<string>();
  return raw.split(',').map((item) => {
    const [column, direction, ...rest] = item.split(':').map((s) => s.trim());
    if (rest.length > 0 || !column) {
      throw badParameter(`Invalid sort item "${item}": expected "column" or "column:asc|desc".`);
    }
    const field = identifier(column, 'sort field');
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
 * Parses the `filters` parameter: the JSON of a FilterNode tree.
 *
 * Only the JSON shape is checked here; structure, bounds (MAX_DEPTH,
 * MAX_CRITERIA), columns and values are validated by compileFilterTree, the
 * same path as the GraphQL `structuredFilters` argument.
 *
 * @param raw - Raw (already URL-decoded) parameter value.
 * @returns The filter tree.
 * @throws {ExportHttpError} 400 when the value is not a JSON object.
 */
function parseFilters(raw: string): FilterNodeInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw badParameter(`Parameter "filters" is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badParameter('Parameter "filters" must be the JSON object of a FilterNode.');
  }
  return parsed as FilterNodeInput;
}

/**
 * Validates the query string of an export request.
 *
 * Pure function: no database access. Column names are validated as SQL
 * identifiers here; their existence in the schema is checked once the
 * metadata is loaded.
 *
 * @param query - Parsed query string (`req.query`).
 * @param settings - Export guards (row ceiling).
 * @returns The validated parameters.
 * @throws {ExportHttpError} 400 on any invalid parameter.
 */
function parseExportQuery(query: Record<string, unknown>, settings: ExportSettings): ExportParams {
  const unknown = Object.keys(query).filter((name) => !KNOWN_PARAMETERS.has(name));
  if (unknown.length > 0) {
    throw badParameter(
      `Unknown parameter(s): ${unknown.join(', ')}. Accepted: ${[...KNOWN_PARAMETERS].join(', ')}.`,
    );
  }

  const catalogRaw = readString(query, 'catalog');
  const schemaRaw = readString(query, 'schema');

  // Format : liste blanche, arrow par défaut
  const formatRaw = (readString(query, 'format') ?? 'arrow').toLowerCase();
  if (!(EXPORT_FORMATS as readonly string[]).includes(formatRaw)) {
    throw badParameter(
      `Unknown format "${formatRaw}". Accepted formats: ${EXPORT_FORMATS.join(', ')}.`,
    );
  }

  // Colonnes projetées : identifiants valides et sans doublon
  const fieldsRaw = readString(query, 'fields');
  let fields: string[] | null = null;
  if (fieldsRaw) {
    fields = fieldsRaw.split(',').map((f) => identifier(f.trim(), 'field'));
    const duplicate = fields.find((f, i) => fields!.indexOf(f) !== i);
    if (duplicate) throw badParameter(`Field "${duplicate}" is given twice.`);
  }

  // Plafond de lignes : jamais au-delà de MAX_ROWS
  const limitRaw = readString(query, 'limit');
  let limit = settings.maxRows;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
      throw badParameter(`Parameter "limit" must be a positive integer, got "${limitRaw}".`);
    }
    limit = Math.min(Number(limitRaw), settings.maxRows);
  }

  const sortRaw = readString(query, 'sort');
  const filtersRaw = readString(query, 'filters');

  return {
    catalog: catalogRaw ? identifier(catalogRaw, 'catalog') : null,
    schema: schemaRaw ? identifier(schemaRaw, 'schema') : null,
    fields,
    filters: filtersRaw ? parseFilters(filtersRaw) : null,
    sort: sortRaw ? parseSort(sortRaw) : null,
    format: formatRaw as ExportFormat,
    limit,
  };
}

export { EXPORT_FORMATS, FORMAT_SPECS, ExportHttpError, loadExportSettings, parseExportQuery };
export type { ExportFormat, ExportParams, ExportSettings };
