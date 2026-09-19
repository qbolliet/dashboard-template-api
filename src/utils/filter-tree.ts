// Importation des modules
import { GraphQLError } from 'graphql';
import { config } from './config-loader.js';
import { validateIdentifier } from './utils.js';

// ─── Types du contrat de filtre ──────────────────────────────────────────────

/** Filter operations exposed by the GraphQL FilterOperation enum. */
const FILTER_OPERATIONS = [
  'EQ',
  'NEQ',
  'GT',
  'GTE',
  'LT',
  'LTE',
  'BETWEEN',
  'IN',
  'NOT_IN',
  'BEFORE',
  'AFTER',
  'CONTAINS',
  'STARTS',
  'IS_NULL',
  'IS_NOT_NULL',
] as const;

/** Filter operation (GraphQL FilterOperation enum value). */
type FilterOperation = (typeof FILTER_OPERATIONS)[number];

/** Logical connector (GraphQL FilterConnector enum value). */
type FilterConnector = 'AND' | 'OR';

/** Family of a SQL column type, which determines the allowed operations. */
type SqlTypeFamily = 'numeric' | 'date' | 'text' | 'boolean';

/** A single criterion of the filter tree (GraphQL FilterCriterion input). */
interface FilterCriterionInput {
  variable: string;
  operation: FilterOperation;
  value?: unknown;
}

/** A node of the filter tree (GraphQL FilterNode input): leaf or group. */
interface FilterNodeInput {
  connector?: FilterConnector | null;
  criterion?: FilterCriterionInput | null;
  children?: FilterNodeInput[] | null;
}

/** Metadata of a filterable column, as read from the metadata table. */
interface ColumnMetadata {
  sql_type?: unknown;
  [key: string]: unknown;
}

/** Parameterized SQL predicate produced from a filter tree. */
interface CompiledFilter {
  sql: string;
  params: unknown[];
}

// ─── Tables de typage ────────────────────────────────────────────────────────

// Types numériques entiers (valeur entière exigée)
const INTEGER_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
]);

// Types numériques non signés (valeur négative refusée)
const UNSIGNED_TYPES = new Set(['UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT']);

// Types numériques flottants
const FLOAT_TYPES = new Set(['FLOAT', 'DOUBLE']);

// Motif strict des décimaux à précision fixe
const DECIMAL_PATTERN = /^DECIMAL\(\d{1,2},\d{1,2}\)$/;

// Types temporels (DATE et variantes de TIMESTAMP)
const DATE_TYPES = new Set([
  'DATE',
  'TIMESTAMP',
  'TIMESTAMP_S',
  'TIMESTAMP_MS',
  'TIMESTAMP_NS',
  'TIMESTAMP WITH TIME ZONE',
  'TIMESTAMPTZ',
]);

// Borne absolue (ms depuis l'epoch) représentable en TIMESTAMP_NS (int64 de ns)
const TIMESTAMP_NS_MAX_ABS_MS = 9_223_372_036_854;

// Types temporels porteurs d'un fuseau horaire
const TIMEZONE_TYPES = new Set(['TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ']);

/** Operations allowed for each SQL type family. */
const ALLOWED_OPERATIONS: Record<SqlTypeFamily, readonly FilterOperation[]> = {
  numeric: [
    'EQ',
    'NEQ',
    'GT',
    'GTE',
    'LT',
    'LTE',
    'BETWEEN',
    'IN',
    'NOT_IN',
    'IS_NULL',
    'IS_NOT_NULL',
  ],
  date: ['EQ', 'NEQ', 'BEFORE', 'AFTER', 'BETWEEN', 'IS_NULL', 'IS_NOT_NULL'],
  text: ['EQ', 'NEQ', 'CONTAINS', 'STARTS', 'IN', 'NOT_IN', 'IS_NULL', 'IS_NOT_NULL'],
  boolean: ['EQ', 'NEQ', 'IS_NULL', 'IS_NOT_NULL'],
};

// Correspondance des opérations de comparaison vers les opérateurs SQL
const COMPARISON_SQL: Partial<Record<FilterOperation, string>> = {
  EQ: '=',
  NEQ: '<>',
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  BEFORE: '<',
  AFTER: '>',
};

// Valeurs par défaut des bornes anti-abus
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_CRITERIA = 50;
const DEFAULT_MAX_IN_VALUES = 1000;

// Motifs de validation des valeurs
const NUMERIC_STRING_PATTERN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const INTEGER_STRING_PATTERN = /^-?\d+$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// ─── Fonctions utilitaires ───────────────────────────────────────────────────

/**
 * Builds a GraphQL error flagged as a client input error.
 *
 * @param message - Human-readable error message.
 * @returns GraphQLError with the BAD_USER_INPUT extension code.
 */
// Construction d'une erreur d'entrée utilisateur
const badInput = (message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * Reads the filter tree bounds from the security configuration.
 *
 * @returns Maximum group depth, criteria count and IN list length.
 */
// Lecture des bornes configurées (valeurs par défaut si absentes)
const getLimits = (): { maxDepth: number; maxCriteria: number; maxInValues: number } => {
  const limits = config?.SECURITY?.FILTER_TREE;
  return {
    maxDepth: limits?.MAX_DEPTH ?? DEFAULT_MAX_DEPTH,
    maxCriteria: limits?.MAX_CRITERIA ?? DEFAULT_MAX_CRITERIA,
    maxInValues: limits?.MAX_IN_VALUES ?? DEFAULT_MAX_IN_VALUES,
  };
};

/**
 * Normalizes a SQL type name (trim, uppercase, collapsed whitespace).
 *
 * @param sqlType - Raw SQL type name.
 * @returns Normalized SQL type name.
 */
// Normalisation d'un nom de type SQL
const normalizeSqlType = (sqlType: string): string =>
  sqlType
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1');

/**
 * Maps a SQL type produced by the database to its filtering family.
 *
 * The recognition is a strict allow-list: a recognized type is therefore safe
 * to interpolate in a CAST expression.
 *
 * @param sqlType - SQL type name as stored in metadata.sql_type.
 * @returns The type family ('numeric', 'date', 'text' or 'boolean').
 * @throws {Error} When the type is not recognized (no default family).
 */
// Détermination de la famille d'un type SQL
function sqlTypeFamily(sqlType: string): SqlTypeFamily {
  const normalized = typeof sqlType === 'string' ? normalizeSqlType(sqlType) : '';
  if (
    INTEGER_TYPES.has(normalized) ||
    FLOAT_TYPES.has(normalized) ||
    DECIMAL_PATTERN.test(normalized)
  ) {
    return 'numeric';
  }
  if (DATE_TYPES.has(normalized)) return 'date';
  if (normalized === 'VARCHAR') return 'text';
  if (normalized === 'BOOLEAN') return 'boolean';
  throw new Error(`Unsupported SQL type "${String(sqlType)}": no filter type family.`);
}

/**
 * Checks that a date/time match describes an existing calendar instant.
 *
 * @param match - Regex match from the ISO date or datetime pattern.
 * @returns True when year/month/day (and time, if present) are valid.
 */
// Vérification calendaire d'une date ISO déjà reconnue par regex
const isValidCalendarDate = (match: RegExpExecArray): boolean => {
  const [, y, m, d, hh, mm, ss] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }
  if (hh !== undefined && (Number(hh) > 23 || Number(mm) > 59)) return false;
  if (ss !== undefined && Number(ss) > 59) return false;
  return true;
};

/**
 * Escapes the LIKE wildcards (and the escape character itself) of a value.
 *
 * @param value - Raw text value.
 * @returns Value safe to embed in a LIKE pattern using ESCAPE '\'.
 */
// Échappement des jokers LIKE (\, % et _)
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Validates and normalizes a single filter value for the column type.
 *
 * @param value - Raw value sent by the client.
 * @param family - Type family of the column.
 * @param sqlType - Normalized SQL type of the column.
 * @param variable - Column name (for error messages).
 * @returns The value to bind as a query parameter.
 * @throws {GraphQLError} When the value does not match the column type.
 */
// Validation d'une valeur selon la famille de type de la colonne
const coerceValue = (
  value: unknown,
  family: SqlTypeFamily,
  sqlType: string,
  variable: string,
): unknown => {
  switch (family) {
    case 'numeric': {
      const isInteger = INTEGER_TYPES.has(sqlType);
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw badInput(`Invalid numeric value for column "${variable}" (${sqlType}).`);
        }
        if (isInteger && !Number.isSafeInteger(value)) {
          throw badInput(
            `Column "${variable}" (${sqlType}) expects an integer; integers beyond 2^53 must be sent as strings.`,
          );
        }
      } else if (typeof value === 'string') {
        const pattern = isInteger ? INTEGER_STRING_PATTERN : NUMERIC_STRING_PATTERN;
        if (!pattern.test(value)) {
          throw badInput(`Invalid numeric value "${value}" for column "${variable}" (${sqlType}).`);
        }
      } else {
        throw badInput(`Column "${variable}" (${sqlType}) expects a numeric value.`);
      }
      if (UNSIGNED_TYPES.has(sqlType) && String(value).startsWith('-')) {
        throw badInput(
          `Column "${variable}" (${sqlType}) is unsigned: negative values are not allowed.`,
        );
      }
      return value;
    }
    case 'date': {
      const pattern = sqlType === 'DATE' ? ISO_DATE_PATTERN : ISO_DATETIME_PATTERN;
      const match = typeof value === 'string' ? pattern.exec(value) : null;
      if (!match || !isValidCalendarDate(match)) {
        const expected = sqlType === 'DATE' ? 'YYYY-MM-DD' : 'ISO 8601 date or date-time';
        throw badInput(
          `Invalid date value ${JSON.stringify(value)} for column "${variable}" (${sqlType}): expected ${expected}.`,
        );
      }
      // TIMESTAMP_NS : plage limitée par un entier 64 bits de nanosecondes
      if (sqlType === 'TIMESTAMP_NS') {
        const [, y, m, d, hh = '0', mm = '0', ss = '0'] = match;
        const epochMs = Date.UTC(
          Number(y),
          Number(m) - 1,
          Number(d),
          Number(hh),
          Number(mm),
          Number(ss),
        );
        if (Math.abs(epochMs) > TIMESTAMP_NS_MAX_ABS_MS) {
          throw badInput(
            `Date value "${String(value)}" is out of range for column "${variable}" (${sqlType}): ` +
              'expected a date between 1677-09-22 and 2262-04-11.',
          );
        }
      }
      // Un décalage horaire explicite serait ignoré silencieusement par DuckDB
      // sur un TIMESTAMP sans fuseau : on le refuse plutôt que de fausser le filtre
      const offset = match[7];
      if (offset && offset !== 'Z' && !TIMEZONE_TYPES.has(sqlType)) {
        throw badInput(
          `Column "${variable}" (${sqlType}) has no time zone: UTC offsets other than "Z" are not allowed.`,
        );
      }
      return value;
    }
    case 'text': {
      if (typeof value !== 'string') {
        throw badInput(`Column "${variable}" (${sqlType}) expects a string value.`);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw badInput(`Column "${variable}" (${sqlType}) expects a boolean value (true/false).`);
      }
      return value;
    }
  }
};

// ─── Validation structurelle ─────────────────────────────────────────────────

/**
 * Validates the structure and bounds of a filter tree and collects its columns.
 *
 * Checks that the root is a non-empty group, that every node sets exactly one
 * of criterion/children, that no group is empty, that connectors are valid,
 * and that the depth and criteria count stay within the configured bounds.
 * Column names are validated as SQL identifiers. No metadata is needed.
 *
 * @param root - Root node of the filter tree.
 * @returns Distinct column names, in order of first appearance.
 * @throws {GraphQLError} When the tree is malformed or exceeds a bound.
 */
// Validation de la structure de l'arbre et collecte des colonnes filtrées
function collectFilterVariables(root: FilterNodeInput): string[] {
  const { maxDepth, maxCriteria } = getLimits();
  const names = new Set<string>();
  let criteriaCount = 0;

  // Parcours récursif avec suivi de la profondeur des groupes
  const walk = (node: FilterNodeInput, depth: number, isRoot: boolean): void => {
    if (node === null || typeof node !== 'object') {
      throw badInput('Invalid filter node: expected an object.');
    }
    const hasCriterion = node.criterion !== undefined && node.criterion !== null;
    const hasChildren = node.children !== undefined && node.children !== null;

    // Exactement un des deux champs criterion / children
    if (hasCriterion === hasChildren) {
      throw badInput('Invalid filter node: exactly one of "criterion" or "children" must be set.');
    }
    if (
      node.connector !== undefined &&
      node.connector !== null &&
      node.connector !== 'AND' &&
      node.connector !== 'OR'
    ) {
      throw badInput(`Invalid filter connector "${String(node.connector)}": expected AND or OR.`);
    }
    if (isRoot && !hasChildren) {
      throw badInput('Invalid filter tree: the root node must be a group (set "children").');
    }

    // Groupe : non vide, profondeur bornée
    if (hasChildren) {
      const children = node.children as FilterNodeInput[];
      if (!Array.isArray(children) || children.length === 0) {
        throw badInput(
          'Invalid filter tree: empty group. Omit structuredFilters entirely to apply no filter.',
        );
      }
      if (depth > maxDepth) {
        throw badInput(`Filter tree too deep: maximum group nesting depth is ${maxDepth}.`);
      }
      children.forEach((child) => walk(child, depth + 1, false));
      return;
    }

    // Feuille : critère compté et colonne validée
    const criterion = node.criterion as FilterCriterionInput;
    criteriaCount += 1;
    if (criteriaCount > maxCriteria) {
      throw badInput(`Too many filter criteria: maximum is ${maxCriteria}.`);
    }
    if (!FILTER_OPERATIONS.includes(criterion.operation)) {
      throw badInput(`Invalid filter operation "${String(criterion.operation)}".`);
    }
    names.add(validateIdentifier(criterion.variable, 'filter variable'));
  };

  walk(root, 0, true);
  return [...names];
}

// ─── Compilation SQL ─────────────────────────────────────────────────────────

/**
 * Compiles a single criterion into a parameterized SQL predicate.
 *
 * @param criterion - Criterion to compile.
 * @param metadataByName - Column metadata keyed by column name.
 * @param params - Parameter list, appended in reading order.
 * @returns SQL predicate with `?` placeholders.
 * @throws {GraphQLError} When the column, operation or value is invalid.
 */
// Compilation d'un critère en prédicat SQL paramétré
const compileCriterion = (
  criterion: FilterCriterionInput,
  metadataByName: ReadonlyMap<string, ColumnMetadata>,
  params: unknown[],
): string => {
  const { variable, operation, value } = criterion;
  const column = validateIdentifier(variable, 'filter variable');

  // Colonne connue de la table metadata
  const meta = metadataByName.get(column);
  if (!meta) {
    throw badInput(`Unknown filter column "${column}": it does not exist in the metadata table.`);
  }

  // Famille de type relue côté serveur (jamais fournie par le client)
  const rawType = typeof meta.sql_type === 'string' ? meta.sql_type : '';
  const sqlType = normalizeSqlType(rawType);
  let family: SqlTypeFamily;
  try {
    family = sqlTypeFamily(sqlType);
  } catch {
    throw badInput(
      `Column "${column}" has an unsupported SQL type "${rawType || 'unknown'}" and cannot be filtered.`,
    );
  }

  // Opération compatible avec la famille de type
  const allowed = ALLOWED_OPERATIONS[family];
  if (!allowed.includes(operation)) {
    throw badInput(
      `Operation ${operation} is not allowed on column "${column}" of type ${sqlType} (${family}). ` +
        `Allowed operations: ${allowed.join(', ')}.`,
    );
  }

  const quoted = `"${column}"`;
  const { maxInValues } = getLimits();

  // Ajout d'une valeur aux paramètres et retour du placeholder adapté au type
  const bind = (raw: unknown): string => {
    params.push(coerceValue(raw, family, sqlType, column));
    return family === 'numeric' || family === 'date' ? `CAST(? AS ${sqlType})` : '?';
  };
  const isScalar = (v: unknown): boolean => v !== undefined && v !== null && typeof v !== 'object';

  switch (operation) {
    case 'IS_NULL':
    case 'IS_NOT_NULL':
      if (value !== undefined && value !== null) {
        throw badInput(`Operation ${operation} on column "${column}" does not take a value.`);
      }
      return `${quoted} ${operation === 'IS_NULL' ? 'IS NULL' : 'IS NOT NULL'}`;

    case 'BETWEEN': {
      const range = value as Record<string, unknown> | null | undefined;
      const keys =
        range && typeof range === 'object' && !Array.isArray(range) ? Object.keys(range) : [];
      if (
        keys.length !== 2 ||
        !keys.includes('min') ||
        !keys.includes('max') ||
        !isScalar(range!.min) ||
        !isScalar(range!.max)
      ) {
        throw badInput(`Operation BETWEEN on column "${column}" requires a value {min, max}.`);
      }
      return `${quoted} BETWEEN ${bind(range!.min)} AND ${bind(range!.max)}`;
    }

    case 'IN':
    case 'NOT_IN': {
      if (!Array.isArray(value) || value.length === 0) {
        throw badInput(`Operation ${operation} on column "${column}" requires a non-empty array.`);
      }
      if (value.length > maxInValues) {
        throw badInput(
          `Operation ${operation} on column "${column}" accepts at most ${maxInValues} values.`,
        );
      }
      if (!value.every(isScalar)) {
        throw badInput(
          `Operation ${operation} on column "${column}" requires non-null scalar values.`,
        );
      }
      const placeholders = value.map(bind).join(', ');
      return `${quoted} ${operation === 'IN' ? 'IN' : 'NOT IN'} (${placeholders})`;
    }

    case 'CONTAINS':
    case 'STARTS': {
      if (typeof value !== 'string' || value.length === 0) {
        throw badInput(`Operation ${operation} on column "${column}" requires a non-empty string.`);
      }
      const escaped = escapeLike(value);
      params.push(operation === 'CONTAINS' ? `%${escaped}%` : `${escaped}%`);
      return `${quoted} LIKE ? ESCAPE '\\'`;
    }

    default: {
      if (!isScalar(value)) {
        throw badInput(`Operation ${operation} on column "${column}" requires a single value.`);
      }
      return `${quoted} ${COMPARISON_SQL[operation]} ${bind(value)}`;
    }
  }
};

/**
 * Converts a filter tree into a parameterized SQL predicate.
 *
 * Only validated identifiers, recognized SQL types and keywords from the
 * internal operation mapping are interpolated; every value becomes a `?`
 * placeholder appended to params in reading order. Children of a group are
 * joined with their connector (the first child's connector is ignored) and
 * sub-groups are parenthesized; the root group is not.
 *
 * @param root - Root node of the filter tree (must be a non-empty group).
 * @param metadataByName - Column metadata (sql_type) keyed by column name.
 * @returns SQL predicate (without WHERE) and its ordered parameters.
 * @throws {GraphQLError} BAD_USER_INPUT when the tree, a column, an operation
 *   or a value is invalid, or when a bound is exceeded.
 */
// Conversion de l'arbre de filtres en SQL paramétré
function treeToSQL(
  root: FilterNodeInput,
  metadataByName: ReadonlyMap<string, ColumnMetadata>,
): CompiledFilter {
  // Validation structurelle et des bornes avant toute génération
  collectFilterVariables(root);

  const params: unknown[] = [];
  const compileNode = (node: FilterNodeInput, isRoot: boolean): string => {
    if (node.criterion) return compileCriterion(node.criterion, metadataByName, params);
    const sql = (node.children as FilterNodeInput[])
      .map((child, index) => {
        const fragment = compileNode(child, false);
        if (index === 0) return fragment;
        return ` ${child.connector === 'OR' ? 'OR' : 'AND'} ${fragment}`;
      })
      .join('');
    // La racine n'est jamais parenthésée ; les sous-groupes le sont
    return isRoot ? sql : `(${sql})`;
  };

  const sql = compileNode(root, true);
  return { sql, params };
}

/**
 * Builds a WHERE clause from a compiled filter.
 *
 * @param compiled - Compiled filter, or null/undefined when there is none.
 * @returns `WHERE <predicate>`, or an empty string.
 */
// Assemblage de la clause WHERE
function buildWhere(compiled: CompiledFilter | null | undefined): string {
  return compiled && compiled.sql ? `WHERE ${compiled.sql}` : '';
}

/**
 * Validates a filter tree, loads the metadata of its columns and compiles it.
 *
 * Structure and bounds are checked before any metadata lookup, so an abusive
 * tree never triggers database work.
 *
 * @param root - Root node of the filter tree, or null/undefined for no filter.
 * @param loadMetadata - Loads metadata rows for the given column names, aligned
 *   by index (typically the metadata DataLoader's loadMany).
 * @returns The compiled filter, or null when no tree was provided.
 * @throws {GraphQLError} BAD_USER_INPUT on any invalid input.
 */
// Validation, chargement des métadonnées et compilation d'un arbre de filtres
async function compileFilterTree(
  root: FilterNodeInput | null | undefined,
  loadMetadata: (names: string[]) => Promise<ReadonlyArray<ColumnMetadata | null | Error>>,
): Promise<CompiledFilter | null> {
  if (root === null || root === undefined) return null;

  const names = collectFilterVariables(root);
  const rows = await loadMetadata(names);

  // Indexation par nom demandé (les erreurs/absences deviennent « colonne inconnue »)
  const metadataByName = new Map<string, ColumnMetadata>();
  names.forEach((name, index) => {
    const row = rows[index];
    if (row && !(row instanceof Error)) metadataByName.set(name, row);
  });

  return treeToSQL(root, metadataByName);
}

export {
  FILTER_OPERATIONS,
  ALLOWED_OPERATIONS,
  sqlTypeFamily,
  collectFilterVariables,
  treeToSQL,
  buildWhere,
  compileFilterTree,
};
export type {
  FilterOperation,
  FilterConnector,
  SqlTypeFamily,
  FilterCriterionInput,
  FilterNodeInput,
  ColumnMetadata,
  CompiledFilter,
};
