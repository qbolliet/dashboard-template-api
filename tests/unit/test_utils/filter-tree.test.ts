/**
 * Unit tests for the filter tree engine (src/utils/filter-tree.ts).
 *
 * Covers the sqlTypeFamily truth table, the exact parameterized SQL produced
 * by treeToSQL (connectors, parenthesization, parameter order, CAST, LIKE
 * escaping), every rejection path (structure, bounds, unknown column/type,
 * incompatible operation, malformed value) and compileFilterTree.
 */

import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import {
  sqlTypeFamily,
  treeToSQL,
  buildWhere,
  collectFilterVariables,
  compileFilterTree,
} from '../../../src/utils/filter-tree.js';
import { config } from '../../../src/utils/config-loader.js';
import type {
  ColumnMetadata,
  FilterNodeInput,
  FilterOperation,
} from '../../../src/utils/filter-tree.js';

// ─── Données de test ──────────────────────────────────────────────────────────

// Métadonnées couvrant chaque famille de type (sqlType relu côté serveur)
const metadataByName = new Map<string, ColumnMetadata>([
  ['country', { sqlType: 'BIGINT' }],
  ['big_id', { sqlType: 'UBIGINT' }],
  ['value', { sqlType: 'DOUBLE' }],
  ['amount', { sqlType: 'DECIMAL(18,3)' }],
  ['day', { sqlType: 'DATE' }],
  ['ts', { sqlType: 'TIMESTAMP' }],
  ['ts_ns', { sqlType: 'TIMESTAMP_NS' }],
  ['ts_tz', { sqlType: 'TIMESTAMP WITH TIME ZONE' }],
  ['label', { sqlType: 'VARCHAR' }],
  ['flag', { sqlType: 'BOOLEAN' }],
  ['blob_col', { sqlType: 'BLOB' }],
]);

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Builds a leaf node.
 *
 * @param variable - Column name.
 * @param operation - Filter operation.
 * @param value - Criterion value.
 * @param connector - Connector with the previous node.
 * @returns FilterNode leaf.
 */
// Construction d'une feuille
const leaf = (
  variable: string,
  operation: FilterOperation,
  value?: unknown,
  connector?: 'AND' | 'OR',
): FilterNodeInput => ({
  ...(connector ? { connector } : {}),
  criterion: { variable, operation, ...(value !== undefined ? { value } : {}) },
});

/**
 * Builds a group node.
 *
 * @param children - Child nodes.
 * @param connector - Connector with the previous node.
 * @returns FilterNode group.
 */
// Construction d'un groupe
const group = (children: FilterNodeInput[], connector?: 'AND' | 'OR'): FilterNodeInput => ({
  ...(connector ? { connector } : {}),
  children,
});

/**
 * Compiles a single-criterion root group.
 *
 * @param node - Leaf node to wrap in a root group.
 * @returns Compiled filter.
 */
// Compilation d'un critère unique sous une racine
const one = (node: FilterNodeInput) => treeToSQL(group([node]), metadataByName);

/**
 * Asserts that a function throws a BAD_USER_INPUT GraphQLError.
 *
 * @param fn - Function expected to throw.
 * @param fragment - Substring expected in the error message.
 */
// Vérification d'un rejet BAD_USER_INPUT
const expectBadInput = (fn: () => unknown, fragment?: string): void => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GraphQLError);
  expect((caught as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
  if (fragment) expect((caught as GraphQLError).message).toContain(fragment);
};

// ─── sqlTypeFamily ────────────────────────────────────────────────────────────

describe('sqlTypeFamily', () => {
  test.each([
    'TINYINT',
    'SMALLINT',
    'INTEGER',
    'BIGINT',
    'HUGEINT',
    'UTINYINT',
    'USMALLINT',
    'UINTEGER',
    'UBIGINT',
    'FLOAT',
    'DOUBLE',
    'DECIMAL(18,3)',
    'DECIMAL(4, 1)',
    'decimal(38,10)',
  ])('%s → numeric', (type) => {
    expect(sqlTypeFamily(type)).toBe('numeric');
  });

  test.each([
    'DATE',
    'TIMESTAMP',
    'TIMESTAMP_S',
    'TIMESTAMP_MS',
    'TIMESTAMP_NS',
    'TIMESTAMP WITH TIME ZONE',
    'timestamp  with time zone',
    'TIMESTAMPTZ',
  ])('%s → date', (type) => {
    expect(sqlTypeFamily(type)).toBe('date');
  });

  test('VARCHAR → text, BOOLEAN → boolean (case-insensitive, trimmed)', () => {
    expect(sqlTypeFamily('VARCHAR')).toBe('text');
    expect(sqlTypeFamily(' varchar ')).toBe('text');
    expect(sqlTypeFamily('BOOLEAN')).toBe('boolean');
  });

  test.each([
    'BLOB',
    'JSON',
    'INTERVAL',
    'TIME',
    'DECIMAL',
    'DECIMAL(18,3); DROP',
    'LIST',
    '',
    'VARCHAR[]',
  ])('rejects unknown type %p (no default family)', (type) => {
    expect(() => sqlTypeFamily(type)).toThrow('Unsupported SQL type');
  });
});

// ─── treeToSQL : génération SQL ──────────────────────────────────────────────

describe('treeToSQL — SQL generation', () => {
  test('flat AND tree (first connector ignored, default AND)', () => {
    const compiled = treeToSQL(
      group([
        leaf('country', 'EQ', 1, 'OR'),
        leaf('value', 'GT', 2.5),
        leaf('label', 'NEQ', 'x', 'AND'),
      ]),
      metadataByName,
    );
    expect(compiled.sql).toBe(
      '"country" = CAST(? AS BIGINT) AND "value" > CAST(? AS DOUBLE) AND "label" <> ?',
    );
    expect(compiled.params).toEqual([1, 2.5, 'x']);
  });

  test('mixed AND/OR with nested sub-groups — exact parenthesization and param order', () => {
    const compiled = treeToSQL(
      group([
        leaf('country', 'IN', [1, 2]),
        group(
          [
            leaf('value', 'GTE', 10),
            group([leaf('label', 'STARTS', 'Fr'), leaf('flag', 'EQ', true, 'OR')], 'AND'),
          ],
          'AND',
        ),
        leaf('day', 'BEFORE', '2024-01-01', 'OR'),
      ]),
      metadataByName,
    );
    expect(compiled.sql).toBe(
      '"country" IN (CAST(? AS BIGINT), CAST(? AS BIGINT))' +
        ' AND ("value" >= CAST(? AS DOUBLE) AND ("label" LIKE ? ESCAPE \'\\\' OR "flag" = ?))' +
        ' OR "day" < CAST(? AS DATE)',
    );
    expect(compiled.params).toEqual([1, 2, 10, 'Fr%', true, '2024-01-01']);
  });

  test('numeric BETWEEN', () => {
    expect(one(leaf('amount', 'BETWEEN', { min: '1.5', max: 10 }))).toEqual({
      sql: '"amount" BETWEEN CAST(? AS DECIMAL(18,3)) AND CAST(? AS DECIMAL(18,3))',
      params: ['1.5', 10],
    });
  });

  test('date BETWEEN with ISO 8601 values', () => {
    expect(one(leaf('day', 'BETWEEN', { min: '2024-01-01', max: '2024-12-31' }))).toEqual({
      sql: '"day" BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)',
      params: ['2024-01-01', '2024-12-31'],
    });
    expect(
      one(leaf('ts', 'BETWEEN', { min: '2024-01-01', max: '2024-06-30T23:59:59.999Z' })).params,
    ).toEqual(['2024-01-01', '2024-06-30T23:59:59.999Z']);
    expect(one(leaf('ts_tz', 'AFTER', '2024-01-01T10:00:00+02:00')).sql).toBe(
      '"ts_tz" > CAST(? AS TIMESTAMP WITH TIME ZONE)',
    );
  });

  test('IN / NOT_IN with a list', () => {
    expect(one(leaf('label', 'IN', ['France', 'Spain']))).toEqual({
      sql: '"label" IN (?, ?)',
      params: ['France', 'Spain'],
    });
    expect(one(leaf('country', 'NOT_IN', [3]))).toEqual({
      sql: '"country" NOT IN (CAST(? AS BIGINT))',
      params: [3],
    });
  });

  test("CONTAINS escapes %, _ and \\ in the value and keeps ' as a plain parameter", () => {
    expect(one(leaf('label', 'CONTAINS', "50%_d'x\\y"))).toEqual({
      sql: '"label" LIKE ? ESCAPE \'\\\'',
      params: ["%50\\%\\_d'x\\\\y%"],
    });
  });

  test('boolean EQ / NEQ bind JS booleans', () => {
    expect(one(leaf('flag', 'EQ', false))).toEqual({ sql: '"flag" = ?', params: [false] });
    expect(one(leaf('flag', 'NEQ', true))).toEqual({ sql: '"flag" <> ?', params: [true] });
  });

  test('IS_NULL / IS_NOT_NULL take no parameter', () => {
    expect(one(leaf('value', 'IS_NULL'))).toEqual({ sql: '"value" IS NULL', params: [] });
    expect(one(leaf('label', 'IS_NOT_NULL', null))).toEqual({
      sql: '"label" IS NOT NULL',
      params: [],
    });
  });

  test('filters on a measure column are accepted like any typed column', () => {
    expect(one(leaf('value', 'LT', -3))).toEqual({
      sql: '"value" < CAST(? AS DOUBLE)',
      params: [-3],
    });
  });

  test('integers beyond 2^53 are accepted as numeric strings (UBIGINT)', () => {
    expect(one(leaf('big_id', 'EQ', '18446744073709551615'))).toEqual({
      sql: '"big_id" = CAST(? AS UBIGINT)',
      params: ['18446744073709551615'],
    });
  });

  test.each<[string, FilterNodeInput, string, unknown[]]>([
    [
      'NOT_BETWEEN',
      leaf('value', 'NOT_BETWEEN', { min: 1, max: 2 }),
      '"value" NOT BETWEEN CAST(? AS DOUBLE) AND CAST(? AS DOUBLE)',
      [1, 2],
    ],
    [
      'ON_OR_BEFORE',
      leaf('day', 'ON_OR_BEFORE', '2024-01-01'),
      '"day" <= CAST(? AS DATE)',
      ['2024-01-01'],
    ],
    [
      'ON_OR_AFTER',
      leaf('ts', 'ON_OR_AFTER', '2024-01-01T06:00:00'),
      '"ts" >= CAST(? AS TIMESTAMP)',
      ['2024-01-01T06:00:00'],
    ],
    [
      'date IN',
      leaf('day', 'IN', ['2024-01-01', '2024-02-01']),
      '"day" IN (CAST(? AS DATE), CAST(? AS DATE))',
      ['2024-01-01', '2024-02-01'],
    ],
    ['ENDS', leaf('label', 'ENDS', 'ce'), `"label" LIKE ? ESCAPE '\\'`, ['%ce']],
    [
      'NOT_CONTAINS',
      leaf('label', 'NOT_CONTAINS', 'ce'),
      `"label" NOT LIKE ? ESCAPE '\\'`,
      ['%ce%'],
    ],
    ['NOT_STARTS', leaf('label', 'NOT_STARTS', 'Fr'), `"label" NOT LIKE ? ESCAPE '\\'`, ['Fr%']],
    ['NOT_ENDS', leaf('label', 'NOT_ENDS', 'ce'), `"label" NOT LIKE ? ESCAPE '\\'`, ['%ce']],
    ['ICONTAINS', leaf('label', 'ICONTAINS', 'fr'), `"label" ILIKE ? ESCAPE '\\'`, ['%fr%']],
    ['ISTARTS', leaf('label', 'ISTARTS', 'fr'), `"label" ILIKE ? ESCAPE '\\'`, ['fr%']],
    ['IENDS', leaf('label', 'IENDS', 'CE'), `"label" ILIKE ? ESCAPE '\\'`, ['%CE']],
    [
      'IEQ (no wildcard added)',
      leaf('label', 'IEQ', 'france'),
      `"label" ILIKE ? ESCAPE '\\'`,
      ['france'],
    ],
    [
      'MATCHES',
      leaf('label', 'MATCHES', '^Fr[ae]nce$'),
      'regexp_matches("label", ?)',
      ['^Fr[ae]nce$'],
    ],
    ['IS_TRUE', leaf('flag', 'IS_TRUE'), '"flag" IS TRUE', []],
    ['IS_FALSE', leaf('flag', 'IS_FALSE'), '"flag" IS FALSE', []],
    ['IS_NOT_TRUE', leaf('flag', 'IS_NOT_TRUE'), '"flag" IS NOT TRUE', []],
    ['IS_NOT_FALSE', leaf('flag', 'IS_NOT_FALSE'), '"flag" IS NOT FALSE', []],
  ])('%s produces its SQL and parameters', (_label, node, sql, params) => {
    expect(one(node)).toEqual({ sql, params });
  });

  test('IEQ / ICONTAINS escape wildcards like their case-sensitive twins', () => {
    expect(one(leaf('label', 'IEQ', '100%_net')).params).toEqual(['100\\%\\_net']);
    expect(one(leaf('label', 'ICONTAINS', '100%')).params).toEqual(['%100\\%%']);
  });

  test.each<[FilterNodeInput['connector'], string]>([
    ['AND', '"value" > CAST(? AS DOUBLE) AND "label" = ?'],
    ['OR', '"value" > CAST(? AS DOUBLE) OR "label" = ?'],
    ['AND_NOT', '"value" > CAST(? AS DOUBLE) AND NOT ("label" = ?)'],
    ['OR_NOT', '"value" > CAST(? AS DOUBLE) OR NOT ("label" = ?)'],
    ['XOR', '("value" > CAST(? AS DOUBLE)) <> ("label" = ?)'],
    ['XNOR', '("value" > CAST(? AS DOUBLE)) = ("label" = ?)'],
    ['NAND', 'NOT (("value" > CAST(? AS DOUBLE)) AND ("label" = ?))'],
    ['NOR', 'NOT (("value" > CAST(? AS DOUBLE)) OR ("label" = ?))'],
  ])('connector %s builds its SQL', (connector, expected) => {
    const compiled = treeToSQL(
      group([leaf('value', 'GT', 1), { ...leaf('label', 'EQ', 'a'), connector }]),
      metadataByName,
    );
    expect(compiled.sql).toBe(expected);
    expect(compiled.params).toEqual([1, 'a']);
  });

  test('a derived connector takes everything on its left as one operand', () => {
    // a AND b, puis XOR c : le run AND/OR devient l'opérande gauche parenthésé
    const compiled = treeToSQL(
      group([
        leaf('value', 'GT', 1),
        leaf('country', 'EQ', 2, 'AND'),
        { ...leaf('flag', 'IS_TRUE'), connector: 'XOR' },
        { ...leaf('label', 'EQ', 'z'), connector: 'OR' },
      ]),
      metadataByName,
    );
    expect(compiled.sql).toBe(
      '("value" > CAST(? AS DOUBLE) AND "country" = CAST(? AS BIGINT)) <> ("flag" IS TRUE)' +
        ' OR "label" = ?',
    );
    expect(compiled.params).toEqual([1, 2, 'z']);
  });

  test('AND_NOT is equivalent to AND on a negated node', () => {
    const viaConnector = treeToSQL(
      group([leaf('value', 'GT', 1), { ...leaf('label', 'EQ', 'a'), connector: 'AND_NOT' }]),
      metadataByName,
    );
    const viaNegate = treeToSQL(
      group([
        leaf('value', 'GT', 1),
        { ...leaf('label', 'EQ', 'a'), connector: 'AND', negate: true },
      ]),
      metadataByName,
    );
    expect(viaConnector).toEqual(viaNegate);
  });

  test('negate wraps a leaf predicate in NOT (…)', () => {
    expect(
      treeToSQL(group([{ ...leaf('country', 'EQ', 1), negate: true }]), metadataByName),
    ).toEqual({
      sql: 'NOT ("country" = CAST(? AS BIGINT))',
      params: [1],
    });
  });

  test('negate wraps a whole group, including the root', () => {
    const negatedGroup = treeToSQL(
      group([
        leaf('flag', 'IS_TRUE'),
        {
          connector: 'AND',
          negate: true,
          children: [leaf('country', 'EQ', 1), leaf('country', 'EQ', 2, 'OR')],
        },
      ]),
      metadataByName,
    );
    expect(negatedGroup.sql).toBe(
      '"flag" IS TRUE AND NOT ("country" = CAST(? AS BIGINT) OR "country" = CAST(? AS BIGINT))',
    );

    // Racine niée : parenthésée bien qu'elle ne le soit jamais autrement
    const negatedRoot = treeToSQL(
      { negate: true, children: [leaf('value', 'GT', 1), leaf('label', 'EQ', 'a', 'OR')] },
      metadataByName,
    );
    expect(negatedRoot.sql).toBe('NOT ("value" > CAST(? AS DOUBLE) OR "label" = ?)');
  });

  test('negate: false and an absent negate behave identically', () => {
    const plain = one(leaf('value', 'GT', 1));
    expect(
      treeToSQL(group([{ ...leaf('value', 'GT', 1), negate: false }]), metadataByName),
    ).toEqual(plain);
  });

  test('buildWhere prefixes WHERE or returns an empty string', () => {
    expect(buildWhere({ sql: '"a" = ?', params: [1] })).toBe('WHERE "a" = ?');
    expect(buildWhere(null)).toBe('');
    expect(buildWhere(undefined)).toBe('');
  });
});

// ─── treeToSQL : rejets ──────────────────────────────────────────────────────

describe('treeToSQL — rejections (BAD_USER_INPUT)', () => {
  test('operation incompatible with the type names column, type and allowed operations', () => {
    expectBadInput(
      () => one(leaf('country', 'CONTAINS', 'x')),
      'Operation CONTAINS is not allowed on column "country" of type BIGINT (numeric). Allowed operations: EQ, NEQ, GT, GTE, LT, LTE, BETWEEN, NOT_BETWEEN, IN, NOT_IN, IS_NULL, IS_NOT_NULL.',
    );
    expectBadInput(
      () => one(leaf('flag', 'GT', true)),
      'Allowed operations: EQ, NEQ, IS_TRUE, IS_FALSE, IS_NOT_TRUE, IS_NOT_FALSE, IS_NULL, IS_NOT_NULL',
    );
    expectBadInput(
      () => one(leaf('day', 'GT', '2024-01-01')),
      'BEFORE, AFTER, ON_OR_BEFORE, ON_OR_AFTER',
    );
    expectBadInput(
      () => one(leaf('label', 'BETWEEN', { min: 'a', max: 'b' })),
      'CONTAINS, NOT_CONTAINS, ICONTAINS',
    );
  });

  test('unknown SQL type in metadata', () => {
    expectBadInput(() => one(leaf('blob_col', 'EQ', 'x')), 'unsupported SQL type "BLOB"');
  });

  test('unknown column', () => {
    expectBadInput(() => one(leaf('missing', 'EQ', 1)), 'Unknown filter column "missing"');
  });

  test.each<[string, FilterNodeInput]>([
    ['BETWEEN without max', leaf('value', 'BETWEEN', { min: 1 })],
    ['BETWEEN with extra key', leaf('value', 'BETWEEN', { min: 1, max: 2, x: 3 })],
    ['BETWEEN with scalar', leaf('value', 'BETWEEN', 5)],
    ['empty IN', leaf('country', 'IN', [])],
    ['IN with scalar', leaf('country', 'IN', 1)],
    ['IN with null element', leaf('country', 'IN', [1, null])],
    ['comparison without value', leaf('value', 'EQ')],
    ['comparison with array', leaf('value', 'EQ', [1])],
    ['IS_NULL with value', leaf('value', 'IS_NULL', 1)],
    ['CONTAINS with empty string', leaf('label', 'CONTAINS', '')],
    ['numeric with SQL fragment', leaf('value', 'EQ', '1 OR 1=1')],
    ['integer with decimal', leaf('country', 'EQ', 1.5)],
    ['integer beyond 2^53 as number', leaf('country', 'EQ', 2 ** 60)],
    ['unsigned with negative', leaf('big_id', 'EQ', -1)],
    ['non-finite number', leaf('value', 'EQ', Number.POSITIVE_INFINITY)],
    ['text with number', leaf('label', 'EQ', 3)],
    ['boolean with string', leaf('flag', 'EQ', 'true')],
    ['non-ISO date', leaf('day', 'EQ', '31/12/2024')],
    ['impossible date', leaf('day', 'EQ', '2024-02-30')],
    ['DATE with time part', leaf('day', 'EQ', '2024-01-01T10:00:00')],
    ['offset on naive TIMESTAMP', leaf('ts', 'AFTER', '2024-01-01T10:00:00+02:00')],
    ['TIMESTAMP_NS out of range', leaf('ts_ns', 'BEFORE', '2999-01-01')],
    ['NOT_BETWEEN without min', leaf('value', 'NOT_BETWEEN', { max: 2 })],
    ['ENDS with empty string', leaf('label', 'ENDS', '')],
    ['ICONTAINS with a number', leaf('label', 'ICONTAINS', 3)],
    ['IS_TRUE with a value', leaf('flag', 'IS_TRUE', true)],
    ['MATCHES with an invalid regex', leaf('label', 'MATCHES', '([a-z')],
    ['MATCHES with an empty pattern', leaf('label', 'MATCHES', '')],
    ['MATCHES with a non-string', leaf('label', 'MATCHES', 5)],
  ])('incomplete or malformed criterion: %s', (_label, node) => {
    expectBadInput(() => one(node));
  });

  test('a regex longer than MAX_PATTERN_LENGTH is rejected', () => {
    const maxPattern = config.SECURITY.FILTER_TREE?.MAX_PATTERN_LENGTH ?? 200;
    expectBadInput(
      () => one(leaf('label', 'MATCHES', 'a'.repeat(maxPattern + 1))),
      `at most ${maxPattern} characters`,
    );
    expect(() => one(leaf('label', 'MATCHES', 'a'.repeat(maxPattern)))).not.toThrow();
  });

  test('case-insensitive and regex operations stay text-only', () => {
    expectBadInput(() => one(leaf('country', 'ICONTAINS', 'x')), 'Allowed operations');
    expectBadInput(() => one(leaf('value', 'MATCHES', '^1$')), 'Allowed operations');
    expectBadInput(() => one(leaf('day', 'IEQ', 'x')), 'Allowed operations');
  });

  test('boolean shortcuts stay boolean-only, date bounds stay date-only', () => {
    expectBadInput(() => one(leaf('label', 'IS_TRUE')), 'Allowed operations');
    expectBadInput(() => one(leaf('label', 'ON_OR_AFTER', 'x')), 'Allowed operations');
  });

  test('a non-boolean negate is rejected', () => {
    expectBadInput(
      () =>
        treeToSQL(
          group([{ ...leaf('value', 'GT', 1), negate: 'yes' as unknown as boolean }]),
          metadataByName,
        ),
      'Invalid "negate" value',
    );
  });

  test('empty group (root or nested) is rejected', () => {
    expectBadInput(() => treeToSQL(group([]), metadataByName), 'empty group');
    expectBadInput(
      () => treeToSQL(group([leaf('value', 'GT', 1), group([], 'AND')]), metadataByName),
      'empty group',
    );
  });

  test('node with both criterion and children (or neither) is rejected', () => {
    const both: FilterNodeInput = {
      criterion: { variable: 'value', operation: 'GT', value: 1 },
      children: [leaf('value', 'LT', 5)],
    };
    expectBadInput(() => treeToSQL(group([both]), metadataByName), 'exactly one');
    expectBadInput(() => treeToSQL(group([{}]), metadataByName), 'exactly one');
  });

  test('root must be a group', () => {
    expectBadInput(
      () => treeToSQL(leaf('value', 'GT', 1), metadataByName),
      'root node must be a group',
    );
  });

  test('invalid connector is rejected', () => {
    expectBadInput(
      () =>
        treeToSQL(
          group([
            leaf('value', 'GT', 1),
            { ...leaf('value', 'LT', 5), connector: 'NOPE' as 'AND' },
          ]),
          metadataByName,
        ),
      'Invalid filter connector',
    );
  });

  test('depth > MAX_DEPTH is rejected, depth = MAX_DEPTH is accepted', () => {
    const maxDepth = config.SECURITY.FILTER_TREE?.MAX_DEPTH ?? 5;
    // Imbrication de n groupes sous la racine (racine = profondeur 0)
    const nested = (n: number): FilterNodeInput => {
      let node: FilterNodeInput = group([leaf('value', 'GT', 1)]);
      for (let i = 1; i < n; i++) node = group([node]);
      return group([node]);
    };
    expect(() => treeToSQL(nested(maxDepth), metadataByName)).not.toThrow();
    expectBadInput(() => treeToSQL(nested(maxDepth + 1), metadataByName), 'too deep');
  });

  test('criteria count > MAX_CRITERIA is rejected', () => {
    const maxCriteria = config.SECURITY.FILTER_TREE?.MAX_CRITERIA ?? 50;
    const many = (n: number) =>
      group(Array.from({ length: n }, (_, i) => leaf('value', 'GT', i, 'OR')));
    expect(() => treeToSQL(many(maxCriteria), metadataByName)).not.toThrow();
    expectBadInput(
      () => treeToSQL(many(maxCriteria + 1), metadataByName),
      'Too many filter criteria',
    );
  });

  test('IN list longer than MAX_IN_VALUES is rejected', () => {
    const maxIn = config.SECURITY.FILTER_TREE?.MAX_IN_VALUES ?? 1000;
    const values = Array.from({ length: maxIn + 1 }, (_, i) => i);
    expectBadInput(() => one(leaf('country', 'IN', values)), `at most ${maxIn} values`);
  });

  test.each(['a; DROP TABLE fact_table', 'country" OR 1=1 --', '1abc', 'x.y'])(
    'malformed variable %p is rejected before any metadata lookup',
    (variable) => {
      expectBadInput(
        () => collectFilterVariables(group([leaf(variable, 'EQ', 1)])),
        'Invalid filter variable',
      );
    },
  );
});

// ─── compileFilterTree ────────────────────────────────────────────────────────

describe('compileFilterTree', () => {
  test('returns null without a tree and never loads metadata', async () => {
    const loadMetadata = jest.fn(async () => []);
    await expect(compileFilterTree(null, loadMetadata)).resolves.toBeNull();
    await expect(compileFilterTree(undefined, loadMetadata)).resolves.toBeNull();
    expect(loadMetadata).not.toHaveBeenCalled();
  });

  test('loads the distinct columns once and compiles the tree', async () => {
    const loadMetadata = jest.fn(async (names: string[]) =>
      names.map((n) => metadataByName.get(n) ?? null),
    );
    const compiled = await compileFilterTree(
      group([leaf('value', 'GT', 1), leaf('value', 'LT', 9), leaf('label', 'EQ', 'a', 'OR')]),
      loadMetadata,
    );

    expect(loadMetadata).toHaveBeenCalledTimes(1);
    expect(loadMetadata).toHaveBeenCalledWith(['value', 'label']);
    expect(compiled).toEqual({
      sql: '"value" > CAST(? AS DOUBLE) AND "value" < CAST(? AS DOUBLE) OR "label" = ?',
      params: [1, 9, 'a'],
    });
  });

  test('missing or failed metadata rows surface as an unknown column', async () => {
    const loadMetadata = async () => [null, new Error('db down')];
    await expect(
      compileFilterTree(group([leaf('value', 'GT', 1), leaf('label', 'EQ', 'a')]), loadMetadata),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Unknown filter column "value"'),
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  test('structure is validated before loading metadata', async () => {
    const loadMetadata = jest.fn(async () => []);
    await expect(compileFilterTree(group([]), loadMetadata)).rejects.toBeInstanceOf(GraphQLError);
    expect(loadMetadata).not.toHaveBeenCalled();
  });
});
