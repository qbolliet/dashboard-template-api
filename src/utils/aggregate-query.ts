// Importation des modules
import { GraphQLError } from 'graphql';
import { config } from './config-loader.js';
import { previewValue } from './preview-value.js';
import { assertColumns, quoteIdent } from './identifiers.js';
import { buildWhere, normalizeSqlType } from './filter-tree.js';
import { resolveLabelField, typeFamilyOf } from './metadata-mapping.js';
import {
  AGGREGATIONS,
  AGGREGATION_SQL,
  aggregatedValueFamily,
  allowedAggregations,
  measureFamily,
} from './aggregations.js';
import type { Json } from '@duckdb/node-api';
import type { CompiledFilter } from './filter-tree.js';
import type { FieldMetadata } from './metadata-mapping.js';
import type {
  AggregateFormat,
  AggregateInput,
  AggregateSortInput,
  Aggregation,
  GroupByInput,
  TimeGrain,
} from '../generated/graphql.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Name of the COUNT(*) column added by includeRowCount. */
const ROW_COUNT_COLUMN = 'row_count';

/** Columns of the LONG format holding the alias and the value of an aggregate. */
const LONG_MEASURE_COLUMN = 'measure';
const LONG_VALUE_COLUMN = 'value';

/** Suffix of the label column of a group column (`<field>__label`). */
const LABEL_SUFFIX = '__label';

/** Shape of an explicit alias. */
const ALIAS_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** Default bounds, when API.AGGREGATES is absent from the configuration. */
const DEFAULT_MAX_AGGREGATES = 20;
const DEFAULT_MAX_GROUP_BY = 4;

/**
 * date_trunc part of each grain. Interpolated in the SQL: the key is an enum
 * value checked by GraphQL, never a client string.
 */
const TIME_GRAIN_PART: Readonly<Record<TimeGrain, string>> = {
  SECOND: 'second',
  MINUTE: 'minute',
  HOUR: 'hour',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  QUARTER: 'quarter',
  YEAR: 'year',
};

// Grains admis sur une colonne DATE (les grains infra-journaliers n'y changent rien)
const DATE_GRAINS: readonly TimeGrain[] = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'];
const TIMESTAMP_GRAINS = Object.keys(TIME_GRAIN_PART) as TimeGrain[];

// Types DuckDB portant un fuseau horaire : troncature calculée en UTC
const TIME_ZONE_TYPES = new Set(['TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ']);

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * How a grained column is truncated: a DATE is cast back to DATE (date_trunc
 * returns a TIMESTAMP), a time-zoned timestamp is truncated in UTC.
 */
type Truncation = 'date' | 'timestamp' | 'timestamptz';

/** A group column, resolved against the metadata. */
interface ResolvedGroup {
  field: string;
  grain: TimeGrain | null;
  /** Set exactly when grain is: the SQL form of the truncation. */
  truncation: Truncation | null;
  /** Label column read by ANY_VALUE (resolveLabelField), null without one or with a grain. */
  labelField: string | null;
}

/** An aggregate, with its effective operation and alias. */
interface ResolvedAggregate {
  measure: string;
  aggregation: Aggregation;
  alias: string;
}

/** A sort criterion on an output column. */
interface ResolvedSort {
  by: string;
  order: 'ASC' | 'DESC';
}

/**
 * Resolved parameters of an aggregate query: every default applied, every name
 * checked. Together with the filter and the page, they form the cache key, so
 * two requests differing only by an implicit value never share an entry.
 */
interface ResolvedAggregateParams {
  groups: ResolvedGroup[];
  /** In the client order: it fixes the order of the columns. */
  aggregates: ResolvedAggregate[];
  /** Client sort followed by the tie-break on every group column. */
  sort: ResolvedSort[];
  includeRowCount: boolean;
}

/** Key of the page loader: resolved parameters, compiled filter and page. */
interface AggregatePageParams extends ResolvedAggregateParams {
  /** Filter compiled by treeToSQL (never built from raw client SQL). */
  where?: CompiledFilter | null;
  limit: number;
  offset: number;
}

/** Key of the group count loader: only what changes the number of groups. */
interface AggregateCountParams {
  groups: ResolvedGroup[];
  where?: CompiledFilter | null;
}

/** SQL of an aggregate query, with its bound values. */
interface AggregateQuery {
  sql: string;
  values: unknown[];
}

/** Request of getAggregates, as received from GraphQL. */
interface AggregateRequest {
  groupBy?: readonly GroupByInput[] | null;
  aggregates: readonly AggregateInput[];
  sort?: readonly AggregateSortInput[] | null;
  includeRowCount?: boolean | null;
  format?: AggregateFormat | null;
}

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Builds a GraphQL error flagged as a client input error.
 *
 * @param message - Human-readable error message.
 * @returns GraphQLError with the BAD_USER_INPUT extension code.
 */
const badInput = (message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * Bounds on the number of aggregates and group columns (API.AGGREGATES).
 *
 * @returns The configured bounds, or their defaults.
 */
// Bornes configurées du nombre d'agrégats et de colonnes de groupe
function aggregateBounds(): { maxAggregates: number; maxGroupBy: number } {
  const bounds = config.API.AGGREGATES;
  return {
    maxAggregates: Number(bounds?.MAX_AGGREGATES ?? DEFAULT_MAX_AGGREGATES),
    maxGroupBy: Number(bounds?.MAX_GROUP_BY ?? DEFAULT_MAX_GROUP_BY),
  };
}

/**
 * Resolves the aggregation actually applied to a measure.
 *
 * The argument wins when the client supplies one; otherwise the measure's
 * `defaultAggregation` metadata applies, and SUM closes the chain for a
 * numeric measure only. A non-numeric measure without defaultAggregation is a
 * client error: COUNT is never implied.
 *
 * @param explicit - Aggregation passed by the client, if any.
 * @param measure - Metadata of the measure.
 * @returns The aggregation to apply.
 * @throws {GraphQLError} BAD_USER_INPUT when no aggregation can be implied.
 */
// Agrégation effective : argument, puis defaultAggregation, puis SUM si numérique
function effectiveAggregation(
  explicit: Aggregation | null | undefined,
  measure: FieldMetadata,
): Aggregation {
  if (explicit) return explicit;

  const declared = measure.defaultAggregation;
  if (declared && AGGREGATIONS.includes(declared as Aggregation)) {
    return declared as Aggregation;
  }
  if (measureFamily(measure.sqlType) === 'numeric') return 'SUM';

  throw badInput(
    `Measure ${previewValue(measure.name)} (${measure.sqlType || 'untyped'}) declares no ` +
      `defaultAggregation; pass aggregation explicitly ` +
      `(allowed: ${allowedAggregations(measure.sqlType).join(', ')}).`,
  );
}

/**
 * Default alias of an aggregate: `<measure>_<aggregation in lower case>`.
 *
 * It keeps the characters of the measure name (quoted in the SQL), so it is
 * not held to the pattern of an explicit alias.
 *
 * @param measure - Aggregated column.
 * @param aggregation - Effective aggregation.
 * @returns The alias.
 */
// Alias par défaut d'un agrégat
function defaultAlias(measure: string, aggregation: Aggregation): string {
  return `${measure}_${aggregation.toLowerCase()}`;
}

/**
 * Label column name of a group column in the result.
 *
 * @param field - Group column.
 * @returns `<field>__label`.
 */
// Nom de la colonne de libellés d'une colonne de groupe
function labelColumnOf(field: string): string {
  return `${field}${LABEL_SUFFIX}`;
}

/**
 * Resolves the truncation of a grained group column.
 *
 * @param field - Metadata of the group column.
 * @param grain - Requested grain.
 * @returns The SQL form of the truncation.
 * @throws {GraphQLError} BAD_USER_INPUT on a non-temporal column, or on a
 *   sub-day grain of a DATE column; the message lists the allowed grains.
 */
// Troncature d'une colonne temporelle selon sa famille de type
function resolveTruncation(field: FieldMetadata, grain: TimeGrain): Truncation {
  const family = typeFamilyOf(field.sqlType);
  if (family !== 'DATE' && family !== 'TIMESTAMP') {
    throw badInput(
      `grain applies to DATE and TIMESTAMP columns only; ${previewValue(field.name)} is ` +
        `${field.sqlType || 'untyped'}.`,
    );
  }
  const allowed = family === 'DATE' ? DATE_GRAINS : TIMESTAMP_GRAINS;
  if (!allowed.includes(grain)) {
    throw badInput(
      `grain ${grain} is not allowed on ${previewValue(field.name)} (${field.sqlType}). ` +
        `Allowed grains: ${allowed.join(', ')}.`,
    );
  }
  if (family === 'DATE') return 'date';
  return TIME_ZONE_TYPES.has(normalizeSqlType(field.sqlType)) ? 'timestamptz' : 'timestamp';
}

/**
 * Display format of an aggregate, derived from the format of its measure.
 *
 * COUNT is an integer count (`,d`); AVG and MEDIAN of an integer measure are
 * fractional, so an integer format (ending with `d`) gets two decimals
 * (`,d` → `,.2f`); every other aggregate keeps the format of its measure.
 *
 * @param aggregation - Effective aggregation.
 * @param measure - Metadata of the measure.
 * @returns The d3-format string, or null when the measure has none.
 */
// Format d3 d'un agrégat, dérivé de celui de la mesure
function aggregateDisplayFormat(aggregation: Aggregation, measure: FieldMetadata): string | null {
  if (aggregation === 'COUNT') return ',d';
  const format = measure.displayFormat;
  if (
    format &&
    (aggregation === 'AVG' || aggregation === 'MEDIAN') &&
    typeFamilyOf(measure.sqlType) === 'INTEGER'
  ) {
    // Spécification d3 d'un entier : précision éventuelle et type `d` en fin
    return format.replace(/(\.\d+)?d$/, '.2f');
  }
  return format;
}

/**
 * Unit of an aggregate: the one of its measure, none for a count.
 *
 * @param aggregation - Effective aggregation.
 * @param measure - Metadata of the measure.
 * @returns The unit, or null.
 */
// Unité d'un agrégat
function aggregateUnit(aggregation: Aggregation, measure: FieldMetadata): string | null {
  return aggregation === 'COUNT' ? null : measure.unit;
}

/**
 * Checks that an aggregate yields a number, as a comparison delta requires.
 *
 * SUM, AVG, MEDIAN and COUNT always do; MIN, MAX and MODE only on a numeric
 * measure (the MIN of a date or the MODE of a text has no delta).
 *
 * @param aggregation - Effective aggregation.
 * @param measure - Metadata of the measure.
 * @throws {GraphQLError} BAD_USER_INPUT when the aggregated value is not numeric.
 */
// Agrégat numérique exigé par le calcul d'un écart
function assertNumericAggregate(aggregation: Aggregation, measure: FieldMetadata): void {
  if (aggregatedValueFamily(aggregation, measure.sqlType) !== 'numeric') {
    throw badInput(
      `${aggregation} of ${previewValue(measure.name)} (${measure.sqlType || 'untyped'}) is not ` +
        'numeric: a comparison computes deltas, so it needs SUM, AVG, MEDIAN or COUNT, or a ' +
        'numeric measure.',
    );
  }
}

// ─── Résolution des paramètres ────────────────────────────────────────────────

/**
 * Validates a getAggregates request and resolves every implicit value.
 *
 * The single gate before the SQL: the group columns and measures must exist in
 * the metadata (assertColumns), a grain needs a temporal column, each
 * aggregation is resolved (argument, defaultAggregation, then SUM for a
 * numeric measure) and checked against the type family of its measure, the
 * aliases are defaulted and checked, the output column names must be unique,
 * and the sort must name output columns. The result is the cache key material:
 * the aggregates keep the client order, which fixes the column order.
 *
 * @param request - Arguments of the query.
 * @param metadataByName - Metadata rows of every group column and measure,
 *   `labelFields` filled; a missing column is reported as unknown.
 * @returns The resolved parameters.
 * @throws {GraphQLError} BAD_USER_INPUT on any invalid argument.
 */
// Validation de la requête et résolution des valeurs implicites
function resolveAggregateParams(
  request: AggregateRequest,
  metadataByName: ReadonlyMap<string, FieldMetadata>,
): ResolvedAggregateParams {
  const groupBy = request.groupBy ?? [];
  const aggregates = request.aggregates ?? [];
  const includeRowCount = request.includeRowCount ?? true;
  const { maxAggregates, maxGroupBy } = aggregateBounds();

  // Bornes du nombre d'agrégats et de colonnes de groupe
  if (aggregates.length === 0) {
    throw badInput('aggregates must hold at least one aggregate.');
  }
  if (aggregates.length > maxAggregates) {
    throw badInput(
      `aggregates cannot hold more than ${maxAggregates} aggregates, got ${aggregates.length}.`,
    );
  }
  if (groupBy.length > maxGroupBy) {
    throw badInput(`groupBy cannot hold more than ${maxGroupBy} columns, got ${groupBy.length}.`);
  }

  // Colonnes contrôlées contre metadata
  const groupFields = groupBy.map((group) => group.field);
  assertColumns(groupFields, metadataByName, 'groupBy');
  assertColumns(
    aggregates.map((aggregate) => aggregate.measure),
    metadataByName,
    'measure',
  );
  const duplicateGroup = groupFields.find((field, index) => groupFields.indexOf(field) !== index);
  if (duplicateGroup !== undefined) {
    throw badInput(`groupBy holds ${previewValue(duplicateGroup)} more than once.`);
  }

  // Colonnes de groupe : troncature temporelle, sinon colonne de libellés
  const groups: ResolvedGroup[] = groupBy.map(({ field, grain }) => {
    const meta = metadataByName.get(field)!;
    if (grain) {
      return { field, grain, truncation: resolveTruncation(meta, grain), labelField: null };
    }
    return {
      field,
      grain: null,
      truncation: null,
      labelField: resolveLabelField(field, metadataByName),
    };
  });

  // Agrégats : agrégation effective, famille de type, alias
  const resolvedAggregates: ResolvedAggregate[] = aggregates.map(
    ({ measure, aggregation, alias }) => {
      const meta = metadataByName.get(measure)!;
      const effective = effectiveAggregation(aggregation, meta);
      const allowed = allowedAggregations(meta.sqlType);
      if (!allowed.includes(effective)) {
        throw badInput(
          `Aggregation ${effective} is not allowed on measure ${previewValue(measure)} ` +
            `(${meta.sqlType || 'untyped'}). Allowed aggregations: ${allowed.join(', ')}.`,
        );
      }
      if (alias !== null && alias !== undefined && !ALIAS_PATTERN.test(alias)) {
        throw badInput(`Alias ${previewValue(alias)} must match ${ALIAS_PATTERN.source}.`);
      }
      return { measure, aggregation: effective, alias: alias ?? defaultAlias(measure, effective) };
    },
  );

  // Noms des colonnes de sortie : uniques, quel que soit leur rôle
  const outputColumns = [
    ...groups.map((group) => group.field),
    ...groups.filter((group) => group.labelField).map((group) => labelColumnOf(group.field)),
    ...resolvedAggregates.map((aggregate) => aggregate.alias),
    ...(includeRowCount ? [ROW_COUNT_COLUMN] : []),
  ];
  const duplicateColumn = outputColumns.find(
    (name, index) => outputColumns.indexOf(name) !== index,
  );
  if (duplicateColumn !== undefined) {
    throw badInput(
      `Output column ${previewValue(duplicateColumn)} is produced more than once ` +
        '(group columns, label columns, aliases and row_count must have distinct names); ' +
        'set a distinct alias.',
    );
  }

  // Format LONG : measure et value sont les colonnes du format
  if (request.format === 'LONG') {
    const reserved = outputColumns
      .filter((name) => !resolvedAggregates.some((aggregate) => aggregate.alias === name))
      .find((name) => name === LONG_MEASURE_COLUMN || name === LONG_VALUE_COLUMN);
    if (reserved !== undefined) {
      throw badInput(
        `The LONG format names its columns ${LONG_MEASURE_COLUMN} and ${LONG_VALUE_COLUMN}: ` +
          `the group column ${previewValue(reserved)} collides with them; use OBJECTS or ARRAYS.`,
      );
    }
  }

  // Tri sur des colonnes de sortie, départagé par toutes les colonnes de groupe
  const sort: ResolvedSort[] = [];
  for (const { by, order } of request.sort ?? []) {
    if (!outputColumns.includes(by)) {
      throw badInput(
        `Unknown sort column ${previewValue(by)}. Sortable columns: ${outputColumns.join(', ')}.`,
      );
    }
    if (order && order !== 'ASC' && order !== 'DESC') {
      throw badInput('Sort order must be either "ASC" or "DESC"');
    }
    if (!sort.some((item) => item.by === by)) sort.push({ by, order: order ?? 'ASC' });
  }
  for (const group of groups) {
    if (!sort.some((item) => item.by === group.field)) {
      sort.push({ by: group.field, order: 'ASC' });
    }
  }

  return { groups, aggregates: resolvedAggregates, sort, includeRowCount };
}

// ─── Construction du SQL ──────────────────────────────────────────────────────

/**
 * SQL expression of a group column: the column itself, or its truncation.
 *
 * @param group - Resolved group column.
 * @returns The SQL expression, identifiers quoted.
 */
// Expression SQL d'une colonne de groupe
function groupExpression(group: ResolvedGroup): string {
  const column = quoteIdent(group.field);
  if (!group.grain || !group.truncation) return column;

  const part = TIME_GRAIN_PART[group.grain];
  switch (group.truncation) {
    // date_trunc renvoie un TIMESTAMP : retour au type DATE de la colonne
    case 'date':
      return `CAST(date_trunc('${part}', ${column}) AS DATE)`;
    // Troncature en UTC, indépendante du fuseau de la session
    case 'timestamptz':
      return `timezone('UTC', date_trunc('${part}', timezone('UTC', ${column})))`;
    default:
      return `date_trunc('${part}', ${column})`;
  }
}

/**
 * Joins the non-empty clauses of a statement with single spaces.
 *
 * @param clauses - SQL clauses, an empty one being skipped (e.g. no WHERE).
 * @returns The statement.
 */
// Assemblage des clauses non vides d'une requête
function sqlClauses(...clauses: string[]): string {
  return clauses.filter((clause) => clause !== '').join(' ');
}

/**
 * Checks a pagination bound before it is interpolated.
 *
 * @param name - Name of the bound, for the message.
 * @param value - Value validated upstream by validatePagination.
 * @returns The value.
 * @throws {Error} When the value is not a non-negative safe integer.
 */
// Contrôle défensif d'une borne de pagination interpolée
function paginationBound(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name} for an aggregate query: ${String(value)}`);
  }
  return value;
}

/**
 * Builds the SQL counting the groups of an aggregate query.
 *
 * Counts the rows of the same GROUP BY as the page query, so the NULL group is
 * included — COUNT(DISTINCT) would leave it out.
 *
 * @param params - Group columns and compiled filter.
 * @param table - Qualified fact table.
 * @returns The count query (one row, column total) and its bound values.
 */
// Comptage des groupes : même GROUP BY que la page, groupe NULL compris
function buildGroupCountQuery(params: AggregateCountParams, table: string): AggregateQuery {
  const inner = sqlClauses(
    `SELECT 1 FROM ${table}`,
    buildWhere(params.where),
    `GROUP BY ${params.groups.map(groupExpression).join(', ')}`,
  );
  return {
    sql: `SELECT COUNT(*) AS total FROM (${inner})`,
    values: params.where?.params ?? [],
  };
}

/**
 * Builds the unsorted, unpaginated SELECT of an aggregate query.
 *
 * The single producer of aggregate SQL: one query computes every aggregate of
 * every group. It selects the group columns (truncated when grained), their
 * labels (ANY_VALUE — licit because the writer guarantees the functional
 * dependency code → label), the aggregates under their aliases and COUNT(*) as
 * row_count. Without group columns there is no GROUP BY: one row, even when no
 * row matches the filter. Identifiers are quoted, the aggregation and grain
 * keywords come from fixed tables, values are bound. getAggregates paginates
 * it (buildAggregateQuery); the comparisons and the export use it as a
 * subquery.
 *
 * @param params - Resolved groups, aggregates and row count flag, compiled
 *   filter; `aggregates` may be empty (group columns only) when there are groups.
 * @param table - Qualified fact table.
 * @returns The SELECT and its bound values.
 */
// Constructeur unique du SELECT d'agrégats, sans tri ni pagination
function buildAggregateSelect(
  params: Omit<ResolvedAggregateParams, 'sort'> & { where?: CompiledFilter | null },
  table: string,
): AggregateQuery {
  const { groups, aggregates, includeRowCount, where } = params;

  // Colonnes de sortie : groupes, libellés, agrégats, comptage
  const select = [
    ...groups.map((group) => `${groupExpression(group)} AS ${quoteIdent(group.field)}`),
    ...groups
      .filter((group) => group.labelField)
      .map(
        (group) =>
          `ANY_VALUE(${quoteIdent(group.labelField!)}) AS ${quoteIdent(labelColumnOf(group.field))}`,
      ),
    ...aggregates.map(
      ({ measure, aggregation, alias }) =>
        `${AGGREGATION_SQL[aggregation]}(${quoteIdent(measure)}) AS ${quoteIdent(alias)}`,
    ),
    ...(includeRowCount ? [`COUNT(*) AS ${quoteIdent(ROW_COUNT_COLUMN)}`] : []),
  ];
  const groupByClause =
    groups.length > 0 ? `GROUP BY ${groups.map(groupExpression).join(', ')}` : '';

  return {
    sql: sqlClauses(`SELECT ${select.join(', ')} FROM ${table}`, buildWhere(where), groupByClause),
    values: where?.params ?? [],
  };
}

/**
 * Renders an ORDER BY over output columns.
 *
 * @param sort - Sort criteria on output columns (quoted here).
 * @returns The ORDER BY clause, or an empty string without criteria.
 */
// Clause ORDER BY sur des colonnes de sortie
function buildOutputOrderBy(sort: readonly ResolvedSort[]): string {
  return sort.length > 0
    ? `ORDER BY ${sort.map(({ by, order }) => `${quoteIdent(by)} ${order === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`
    : '';
}

/**
 * Builds the SQL of one page of an aggregate query.
 *
 * The SELECT of buildAggregateSelect, sorted in an outer query on its output
 * columns only — no ambiguity when a grained column keeps the name of its
 * source — then paginated.
 *
 * @param params - Resolved parameters, compiled filter and page.
 * @param table - Qualified fact table.
 * @returns The page query and its bound values.
 */
// Page d'agrégats : SELECT d'agrégats trié puis paginé
function buildAggregateQuery(params: AggregatePageParams, table: string): AggregateQuery {
  const limit = paginationBound('limit', params.limit);
  const offset = paginationBound('offset', params.offset);
  const inner = buildAggregateSelect(params, table);
  return {
    sql: sqlClauses(
      `SELECT * FROM (${inner.sql})`,
      buildOutputOrderBy(params.sort),
      `LIMIT ${limit} OFFSET ${offset}`,
    ),
    values: inner.values,
  };
}

// ─── Mise en forme ────────────────────────────────────────────────────────────

/**
 * Columns of the LONG format, in order.
 *
 * @param columns - Columns of the OBJECTS rows.
 * @param aliases - Aliases of the aggregates, melted into measure/value.
 * @returns Identifier columns, then measure and value.
 */
// Colonnes du format LONG
function longColumns(columns: readonly string[], aliases: readonly string[]): string[] {
  return [
    ...columns.filter((column) => !aliases.includes(column)),
    LONG_MEASURE_COLUMN,
    LONG_VALUE_COLUMN,
  ];
}

/**
 * Melts OBJECTS rows into the LONG (tidy) format.
 *
 * Each row yields one row per aggregate, in the order of the aggregates:
 * the identifier columns (groups, labels, row_count), then `measure` (the
 * alias) and `value`.
 *
 * @param rows - Rows of the OBJECTS format.
 * @param columns - Columns of the OBJECTS rows.
 * @param aliases - Aliases of the aggregates, in order.
 * @returns The melted rows.
 */
// Fonte des lignes OBJECTS en format long
function meltRows(
  rows: readonly Record<string, Json>[],
  columns: readonly string[],
  aliases: readonly string[],
): Record<string, Json>[] {
  const identifiers = columns.filter((column) => !aliases.includes(column));
  return rows.flatMap((row) => {
    const base: Record<string, Json> = {};
    for (const column of identifiers) base[column] = row[column] ?? null;
    return aliases.map((alias) => ({
      ...base,
      [LONG_MEASURE_COLUMN]: alias,
      [LONG_VALUE_COLUMN]: row[alias] ?? null,
    }));
  });
}

export {
  ROW_COUNT_COLUMN,
  TIME_GRAIN_PART,
  badInput,
  effectiveAggregation,
  assertNumericAggregate,
  defaultAlias,
  labelColumnOf,
  aggregateDisplayFormat,
  aggregateUnit,
  resolveAggregateParams,
  buildAggregateSelect,
  buildOutputOrderBy,
  buildAggregateQuery,
  buildGroupCountQuery,
  paginationBound,
  longColumns,
  meltRows,
};
export type {
  AggregateRequest,
  ResolvedGroup,
  ResolvedAggregate,
  ResolvedSort,
  ResolvedAggregateParams,
  AggregatePageParams,
  AggregateCountParams,
  AggregateQuery,
};
