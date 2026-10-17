// Importation des modules
import { GraphQLError } from 'graphql';
import { config } from './config-loader.js';
import { quoteIdent } from './identifiers.js';
import { previewValue } from './preview-value.js';

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
  'NOT_BETWEEN',
  'IN',
  'NOT_IN',
  'BEFORE',
  'AFTER',
  'ON_OR_BEFORE',
  'ON_OR_AFTER',
  'CONTAINS',
  'NOT_CONTAINS',
  'STARTS',
  'NOT_STARTS',
  'ENDS',
  'NOT_ENDS',
  'IEQ',
  'ICONTAINS',
  'ISTARTS',
  'IENDS',
  'MATCHES',
  'IS_NULL',
  'IS_NOT_NULL',
  'IS_TRUE',
  'IS_FALSE',
  'IS_NOT_TRUE',
  'IS_NOT_FALSE',
] as const;

/** Filter operation (GraphQL FilterOperation enum value). */
type FilterOperation = (typeof FILTER_OPERATIONS)[number];

/** Logical connectors exposed by the GraphQL FilterConnector enum. */
const FILTER_CONNECTORS = ['AND', 'OR', 'AND_NOT', 'OR_NOT', 'XOR', 'XNOR', 'NAND', 'NOR'] as const;

/** Logical connector (GraphQL FilterConnector enum value). */
type FilterConnector = (typeof FILTER_CONNECTORS)[number];

/**
 * Family of a SQL column type, which determines the allowed operations.
 *
 * `other` groups every type without a filter semantics (TIME, INTERVAL, BLOB,
 * nested types…): such a column is listed, projected and sorted like any other,
 * but only IS_NULL / IS_NOT_NULL apply to it — any other operation is a client
 * error.
 */
type SqlTypeFamily = 'numeric' | 'date' | 'text' | 'boolean' | 'other';

/** A single criterion of the filter tree (GraphQL FilterCriterion input). */
interface FilterCriterionInput {
  variable: string;
  operation: FilterOperation;
  value?: unknown;
}

/** A node of the filter tree (GraphQL FilterNode input): leaf or group. */
interface FilterNodeInput {
  connector?: FilterConnector | null;
  /** Negates this node (leaf or whole group): `NOT (…)`. */
  negate?: boolean | null;
  criterion?: FilterCriterionInput | null;
  children?: FilterNodeInput[] | null;
}

/** Metadata of a filterable column, as read from the metadata table. */
interface ColumnMetadata {
  sqlType?: unknown;
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
  'UHUGEINT',
]);

// Types numériques non signés (valeur négative refusée)
const UNSIGNED_TYPES = new Set(['UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT']);

// Types numériques flottants
const FLOAT_TYPES = new Set(['FLOAT', 'DOUBLE']);

// Motif strict des décimaux : DECIMAL nu (tel que l'écrit la base), DECIMAL(p) ou DECIMAL(p,s)
const DECIMAL_PATTERN = /^DECIMAL(?:\((\d{1,2})(?:,(\d{1,2}))?\))?$/;

// Précision maximale d'un DECIMAL DuckDB (chiffres significatifs)
const DECIMAL_MAX_PRECISION = 38;

// Cible du CAST pour un DECIMAL sans précision : la précision physique de la
// colonne est inconnue, et le DECIMAL par défaut de DuckDB (18,3) arrondirait la
// valeur à 3 décimales avant la comparaison. 9 décimales couvrent les usages et
// laissent 29 chiffres entiers.
const BARE_DECIMAL_CAST_TYPE = 'DECIMAL(38,9)';

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
    'NOT_BETWEEN',
    'IN',
    'NOT_IN',
    'IS_NULL',
    'IS_NOT_NULL',
  ],
  date: [
    'EQ',
    'NEQ',
    'BEFORE',
    'AFTER',
    'ON_OR_BEFORE',
    'ON_OR_AFTER',
    'BETWEEN',
    'NOT_BETWEEN',
    'IN',
    'NOT_IN',
    'IS_NULL',
    'IS_NOT_NULL',
  ],
  text: [
    'EQ',
    'NEQ',
    'IEQ',
    'CONTAINS',
    'NOT_CONTAINS',
    'ICONTAINS',
    'STARTS',
    'NOT_STARTS',
    'ISTARTS',
    'ENDS',
    'NOT_ENDS',
    'IENDS',
    'MATCHES',
    'IN',
    'NOT_IN',
    'IS_NULL',
    'IS_NOT_NULL',
  ],
  boolean: [
    'EQ',
    'NEQ',
    'IS_TRUE',
    'IS_FALSE',
    'IS_NOT_TRUE',
    'IS_NOT_FALSE',
    'IS_NULL',
    'IS_NOT_NULL',
  ],
  // Seulement la présence : IS NULL ne lie aucune valeur et ne CAST rien, sûr sur tout type
  other: ['IS_NULL', 'IS_NOT_NULL'],
};

/**
 * LIKE-family operations: SQL operator and how the value becomes a pattern.
 *
 * ILIKE variants are case-insensitive; `exact` builds no wildcard at all
 * (case-insensitive equality). Wildcards inside the value are always escaped,
 * so a `%` or `_` typed by the user matches literally.
 */
const LIKE_OPERATIONS: Partial<
  Record<FilterOperation, { sql: string; pattern: 'contains' | 'starts' | 'ends' | 'exact' }>
> = {
  CONTAINS: { sql: 'LIKE', pattern: 'contains' },
  NOT_CONTAINS: { sql: 'NOT LIKE', pattern: 'contains' },
  ICONTAINS: { sql: 'ILIKE', pattern: 'contains' },
  STARTS: { sql: 'LIKE', pattern: 'starts' },
  NOT_STARTS: { sql: 'NOT LIKE', pattern: 'starts' },
  ISTARTS: { sql: 'ILIKE', pattern: 'starts' },
  ENDS: { sql: 'LIKE', pattern: 'ends' },
  NOT_ENDS: { sql: 'NOT LIKE', pattern: 'ends' },
  IENDS: { sql: 'ILIKE', pattern: 'ends' },
  IEQ: { sql: 'ILIKE', pattern: 'exact' },
};

/**
 * Combines the expression built so far with the next node's predicate.
 *
 * AND / OR / AND_NOT / OR_NOT are appended flat, so ordinary SQL precedence
 * applies within a run (NOT binds tightest, then AND, then OR) — the semantics
 * of the frontend's treeToSQL. The derived connectors have no SQL keyword in
 * DuckDB and are built from NOT / AND / OR or from boolean (in)equality; they
 * take everything on their left as a single operand, which is why the left side
 * is parenthesized. Wrapping a complete expression in parentheses never changes
 * its meaning, so a preceding AND / OR run keeps its precedence semantics.
 *
 * All of them follow SQL three-valued logic: a NULL operand yields NULL, so the
 * row is not selected (NOR is the one exception, being true only when both
 * operands are false).
 */
const CONNECTOR_COMBINERS: Record<FilterConnector, (left: string, right: string) => string> = {
  AND: (left, right) => `${left} AND ${right}`,
  OR: (left, right) => `${left} OR ${right}`,
  AND_NOT: (left, right) => `${left} AND NOT (${right})`,
  OR_NOT: (left, right) => `${left} OR NOT (${right})`,
  // Ou exclusif : inégalité booléenne (DuckDB n'a pas de mot-clé XOR)
  XOR: (left, right) => `(${left}) <> (${right})`,
  // Équivalence : les deux prédicats ont la même valeur de vérité
  XNOR: (left, right) => `(${left}) = (${right})`,
  NAND: (left, right) => `NOT ((${left}) AND (${right}))`,
  NOR: (left, right) => `NOT ((${left}) OR (${right}))`,
};

/** Value-less operations and their SQL predicate. */
const VALUELESS_SQL: Partial<Record<FilterOperation, string>> = {
  IS_NULL: 'IS NULL',
  IS_NOT_NULL: 'IS NOT NULL',
  IS_TRUE: 'IS TRUE',
  IS_FALSE: 'IS FALSE',
  IS_NOT_TRUE: 'IS NOT TRUE',
  IS_NOT_FALSE: 'IS NOT FALSE',
};

/** SQL operator of each comparison operation (`EQ` → `=`, `GT` → `>`, …). */
const COMPARISON_SQL: Partial<Record<FilterOperation, string>> = {
  EQ: '=',
  NEQ: '<>',
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  BEFORE: '<',
  AFTER: '>',
  ON_OR_BEFORE: '<=',
  ON_OR_AFTER: '>=',
};

// Valeurs par défaut des bornes anti-abus
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_CRITERIA = 50;
const DEFAULT_MAX_IN_VALUES = 1000;
const DEFAULT_MAX_PATTERN_LENGTH = 200;

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
const getLimits = (): {
  maxDepth: number;
  maxCriteria: number;
  maxInValues: number;
  maxPatternLength: number;
} => {
  const limits = config?.SECURITY?.FILTER_TREE;
  return {
    maxDepth: limits?.MAX_DEPTH ?? DEFAULT_MAX_DEPTH,
    maxCriteria: limits?.MAX_CRITERIA ?? DEFAULT_MAX_CRITERIA,
    maxInValues: limits?.MAX_IN_VALUES ?? DEFAULT_MAX_IN_VALUES,
    maxPatternLength: limits?.MAX_PATTERN_LENGTH ?? DEFAULT_MAX_PATTERN_LENGTH,
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
 * Tells whether a normalized type is a DECIMAL DuckDB can hold.
 *
 * Bare `DECIMAL` (how the database writes the type of a decimal column),
 * `DECIMAL(p)` and `DECIMAL(p,s)` are accepted, with 1 <= p <= 38 and s <= p.
 *
 * @param normalized - SQL type after {@link normalizeSqlType}.
 * @returns True for a well-formed DECIMAL type.
 */
// Reconnaissance d'un DECIMAL, nu ou avec précision (p ≤ 38, s ≤ p)
const isDecimalType = (normalized: string): boolean => {
  const match = DECIMAL_PATTERN.exec(normalized);
  if (!match) return false;
  if (match[1] === undefined) return true;
  const precision = Number(match[1]);
  const scale = match[2] === undefined ? 0 : Number(match[2]);
  return precision >= 1 && precision <= DECIMAL_MAX_PRECISION && scale <= precision;
};

/**
 * Maps a SQL type produced by the database to its filtering family.
 *
 * Total: a type that is not numeric, temporal, text or boolean — TIME,
 * INTERVAL, BLOB, nested types, an empty or malformed name — belongs to the
 * `other` family, so no caller needs a try/catch. The numeric, date, text and
 * boolean families are a strict allow-list, hence safe to interpolate in a CAST
 * expression (see `castTypeOf`); `other` is never interpolated anywhere,
 * since only the value-less IS_NULL / IS_NOT_NULL apply to it.
 *
 * @param sqlType - SQL type name as stored in metadata.sqlType.
 * @returns The type family.
 */
// Détermination de la famille d'un type SQL (jamais d'exception)
function sqlTypeFamily(sqlType: string): SqlTypeFamily {
  const normalized = typeof sqlType === 'string' ? normalizeSqlType(sqlType) : '';
  if (INTEGER_TYPES.has(normalized) || FLOAT_TYPES.has(normalized) || isDecimalType(normalized)) {
    return 'numeric';
  }
  if (DATE_TYPES.has(normalized)) return 'date';
  if (normalized === 'VARCHAR') return 'text';
  if (normalized === 'BOOLEAN') return 'boolean';
  return 'other';
}

/**
 * Tells whether a SQL type is an integer type of the `numeric` family.
 *
 * Splits the `numeric` family between integers (TINYINT … UHUGEINT) and
 * floating-point or decimal types, from the same allow-list as
 * {@link sqlTypeFamily}. Total, like it.
 *
 * @param sqlType - SQL type name as stored in metadata.sqlType.
 * @returns True for a signed or unsigned integer type.
 */
// Reconnaissance d'un type entier (jamais d'exception)
function isIntegerSqlType(sqlType: string): boolean {
  return typeof sqlType === 'string' && INTEGER_TYPES.has(normalizeSqlType(sqlType));
}

/**
 * Returns the type a filter value is CAST to before the comparison.
 *
 * The column's own type, except for a bare `DECIMAL`, whose precision is
 * unknown (see {@link BARE_DECIMAL_CAST_TYPE}).
 *
 * @param sqlType - Normalized SQL type of a numeric or date column.
 * @returns A type name from the allow-list, safe to interpolate.
 */
// Type cible du CAST d'une valeur de filtre
const castTypeOf = (sqlType: string): string =>
  sqlType === 'DECIMAL' ? BARE_DECIMAL_CAST_TYPE : sqlType;

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
 * Validates a filter variable before any metadata lookup.
 *
 * Any column name the database accepts is allowed (it is quoted in the SQL);
 * only a non-string or empty value is rejected here. Existence is checked
 * afterwards against the metadata table.
 *
 * @param variable - Column name sent by the client.
 * @returns The column name, unchanged.
 * @throws {GraphQLError} BAD_USER_INPUT when the variable is not a non-empty string.
 */
// Contrôle de forme d'une variable de filtre (l'existence est vérifiée contre metadata)
const filterVariable = (variable: unknown): string => {
  if (typeof variable !== 'string' || variable === '') {
    throw badInput(`Invalid filter variable ${previewValue(variable)}.`);
  }
  return variable;
};

/**
 * Rejects the regular expression constructs RE2 does not support.
 *
 * DuckDB's `regexp_matches` runs RE2, which has no lookaround, no atomic
 * group, no back-reference, and (in the bundled version) no `(?<name>…)`
 * named group — `(?P<name>…)` is the supported spelling. These constructs are
 * valid JavaScript regexes, so they are detected here with a message naming
 * them; any other syntax error is raised by DuckDB itself and mapped to
 * BAD_USER_INPUT by the loader. Escaped characters and character classes are
 * skipped, so `\\1` or `[(?=]` are not false positives.
 *
 * @param pattern - Regular expression sent by the client.
 * @param column - Column name, quoted in the error message.
 * @throws {GraphQLError} BAD_USER_INPUT when an unsupported construct is found.
 */
// Refus des constructions non supportées par RE2 (lookaround, rétro-références…)
const assertRe2Compatible = (pattern: string, column: string): void => {
  const reject = (construct: string): never => {
    throw badInput(
      `Operation MATCHES on column "${column}": ${construct} is not supported ` +
        '(RE2 syntax: no lookaround, atomic group or back-reference).',
    );
  };

  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next)) reject(`back-reference "\\${next}"`);
      if (next === 'k' && pattern[i + 2] === '<') reject('named back-reference "\\k<…>"');
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      // Un « ] » placé juste après « [ » ou « [^ » est littéral
      if (pattern[i + 1] === '^') i += 1;
      if (pattern[i + 1] === ']') i += 1;
      continue;
    }
    if (char === '(' && pattern[i + 1] === '?') {
      const head = pattern.slice(i + 2, i + 4);
      if (head.startsWith('=')) reject('lookahead "(?="');
      if (head.startsWith('!')) reject('negative lookahead "(?!"');
      if (head === '<=') reject('lookbehind "(?<="');
      if (head === '<!') reject('negative lookbehind "(?<!"');
      if (head.startsWith('<')) reject('named group "(?<name>…)" (use "(?P<name>…)")');
      if (head.startsWith('>')) reject('atomic group "(?>"');
    }
  }
};

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
          throw badInput(
            `Invalid numeric value ${previewValue(value)} for column "${variable}" (${sqlType}).`,
          );
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
          `Invalid date value ${previewValue(value)} for column "${variable}" (${sqlType}): expected ${expected}.`,
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
            `Date value ${previewValue(value)} is out of range for column "${variable}" (${sqlType}): ` +
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
    case 'other':
      // Inatteignable : seules IS_NULL / IS_NOT_NULL sont permises, et elles ne lient aucune valeur
      throw badInput(`Column "${variable}" (${sqlType}) takes no filter value.`);
  }
};

// ─── Validation structurelle ─────────────────────────────────────────────────

/**
 * Validates the structure and bounds of a filter tree and collects its columns.
 *
 * Checks that the root is a non-empty group, that every node sets exactly one
 * of criterion/children, that no group is empty, that connectors are valid,
 * and that the depth and criteria count stay within the configured bounds.
 * Column names must be non-empty strings; their existence is checked later
 * against the metadata table. No metadata is needed here.
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
      !FILTER_CONNECTORS.includes(node.connector)
    ) {
      throw badInput(
        `Invalid filter connector ${previewValue(node.connector)}: expected one of ${FILTER_CONNECTORS.join(', ')}.`,
      );
    }
    if (node.negate !== undefined && node.negate !== null && typeof node.negate !== 'boolean') {
      throw badInput(`Invalid "negate" value ${previewValue(node.negate)}: expected a boolean.`);
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
      throw badInput(`Invalid filter operation ${previewValue(criterion.operation)}.`);
    }
    names.add(filterVariable(criterion.variable));
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
  const column = filterVariable(variable);

  // Colonne connue de la table metadata
  const meta = metadataByName.get(column);
  if (!meta) {
    throw badInput(
      `Unknown filter column ${previewValue(column)}: it does not exist in the metadata table.`,
    );
  }

  // Famille de type relue côté serveur (jamais fournie par le client)
  const rawType = typeof meta.sqlType === 'string' ? meta.sqlType : '';
  const sqlType = normalizeSqlType(rawType);
  const family = sqlTypeFamily(sqlType);

  // Opération compatible avec la famille de type
  const allowed = ALLOWED_OPERATIONS[family];
  if (family === 'other' && !allowed.includes(operation)) {
    throw badInput(
      `Column "${column}" has an unsupported SQL type "${rawType || 'unknown'}": ` +
        `only ${allowed.join(' and ')} are allowed ` +
        '(fully filterable types are numeric, DATE/TIMESTAMP, VARCHAR and BOOLEAN).',
    );
  }
  if (!allowed.includes(operation)) {
    throw badInput(
      `Operation ${operation} is not allowed on column "${column}" of type ${sqlType} (${family}). ` +
        `Allowed operations: ${allowed.join(', ')}.`,
    );
  }

  const quoted = quoteIdent(column);
  const { maxInValues, maxPatternLength } = getLimits();

  // Ajout d'une valeur aux paramètres et retour du placeholder adapté au type
  const bind = (raw: unknown): string => {
    params.push(coerceValue(raw, family, sqlType, column));
    return family === 'numeric' || family === 'date' ? `CAST(? AS ${castTypeOf(sqlType)})` : '?';
  };
  const isScalar = (v: unknown): boolean => v !== undefined && v !== null && typeof v !== 'object';

  // Opérations sans valeur (IS NULL, IS TRUE…)
  const valueless = VALUELESS_SQL[operation];
  if (valueless) {
    if (value !== undefined && value !== null) {
      throw badInput(`Operation ${operation} on column "${column}" does not take a value.`);
    }
    return `${quoted} ${valueless}`;
  }

  // Opérations de la famille LIKE / ILIKE (jokers échappés dans la valeur)
  const likeOperation = LIKE_OPERATIONS[operation];
  if (likeOperation) {
    if (typeof value !== 'string' || value.length === 0) {
      throw badInput(`Operation ${operation} on column "${column}" requires a non-empty string.`);
    }
    const escaped = escapeLike(value);
    const patterns = {
      contains: `%${escaped}%`,
      starts: `${escaped}%`,
      ends: `%${escaped}`,
      exact: escaped,
    };
    params.push(patterns[likeOperation.pattern]);
    return `${quoted} ${likeOperation.sql} ? ESCAPE '\\'`;
  }

  switch (operation) {
    case 'MATCHES': {
      // Expression régulière RE2 (DuckDB) : pas de backtracking catastrophique,
      // mais la longueur reste bornée. Les constructions absentes de RE2 sont
      // refusées ici ; toute autre erreur de syntaxe est levée par DuckDB et
      // convertie en BAD_USER_INPUT par le loader. Pas de validation par
      // RegExp (JS) : elle accepte des lookarounds et refuse `(?i)`, valide en RE2.
      if (typeof value !== 'string' || value.length === 0) {
        throw badInput(`Operation MATCHES on column "${column}" requires a non-empty pattern.`);
      }
      if (value.length > maxPatternLength) {
        throw badInput(
          `Operation MATCHES on column "${column}" accepts patterns of at most ${maxPatternLength} characters.`,
        );
      }
      assertRe2Compatible(value, column);
      params.push(value);
      return `regexp_matches(${quoted}, ?)`;
    }

    case 'BETWEEN':
    case 'NOT_BETWEEN': {
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
        throw badInput(`Operation ${operation} on column "${column}" requires a value {min, max}.`);
      }
      const keyword = operation === 'BETWEEN' ? 'BETWEEN' : 'NOT BETWEEN';
      return `${quoted} ${keyword} ${bind(range!.min)} AND ${bind(range!.max)}`;
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
 * combined left to right with their connector (the first child's connector is
 * ignored, and an absent connector means AND); sub-groups are parenthesized,
 * the root group is not. See CONNECTOR_COMBINERS for how each connector binds.
 *
 * @param root - Root node of the filter tree (must be a non-empty group).
 * @param metadataByName - Column metadata (sqlType) keyed by column name.
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
    // Feuille : prédicat du critère, éventuellement nié
    if (node.criterion) {
      const predicate = compileCriterion(node.criterion, metadataByName, params);
      return node.negate ? `NOT (${predicate})` : predicate;
    }

    // Combinaison de gauche à droite : le connecteur d'un enfant le relie à
    // l'expression déjà construite (celui du premier enfant est ignoré).
    const sql = (node.children as FilterNodeInput[]).reduce((accumulated, child, index) => {
      const fragment = compileNode(child, false);
      if (index === 0) return fragment;
      const combine = CONNECTOR_COMBINERS[child.connector ?? 'AND'];
      return combine(accumulated, fragment);
    }, '');

    // Un groupe nié est toujours parenthésé, racine comprise ; sinon seule la
    // racine échappe aux parenthèses.
    if (node.negate) return `NOT (${sql})`;
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
 * tree never triggers database work. A metadata row that failed to load (an
 * Error, e.g. the catalog is unreachable) is rethrown as is: only a missing
 * row means an unknown column.
 *
 * @param root - Root node of the filter tree, or null/undefined for no filter.
 * @param loadMetadata - Loads metadata rows for the given column names, aligned
 *   by index (typically the metadata DataLoader's loadMany).
 * @returns The compiled filter, or null when no tree was provided.
 * @throws {GraphQLError} BAD_USER_INPUT on any invalid input.
 * @throws {Error} The loading error of a metadata row.
 */
// Validation, chargement des métadonnées et compilation d'un arbre de filtres
async function compileFilterTree(
  root: FilterNodeInput | null | undefined,
  loadMetadata: (names: string[]) => Promise<ReadonlyArray<ColumnMetadata | null | Error>>,
): Promise<CompiledFilter | null> {
  if (root === null || root === undefined) return null;

  const names = collectFilterVariables(root);
  const rows = await loadMetadata(names);

  // Une erreur de chargement remonte telle quelle : ce n'est pas une colonne inconnue
  const failure = rows.find((row): row is Error => row instanceof Error);
  if (failure) throw failure;

  // Indexation par nom demandé (les absences deviennent « colonne inconnue »)
  const metadataByName = new Map<string, ColumnMetadata>();
  names.forEach((name, index) => {
    const row = rows[index];
    if (row) metadataByName.set(name, row as ColumnMetadata);
  });

  return treeToSQL(root, metadataByName);
}

export {
  FILTER_OPERATIONS,
  FILTER_CONNECTORS,
  ALLOWED_OPERATIONS,
  normalizeSqlType,
  sqlTypeFamily,
  isIntegerSqlType,
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
