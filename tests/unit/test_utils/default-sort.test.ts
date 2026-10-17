/**
 * Unit tests for the effective sort of fact table queries
 * (src/utils/default-sort.ts).
 *
 * Covers the fallback chain without an explicit sort (cluster_by, then the
 * primary keys, then ORDER BY ALL, warned once per schema), and the tiebreakers
 * appended to an explicit sort (the primary keys, or every other column when the
 * schema has none). The loaders are faked: what is under test is the choice of
 * ordering, not the database (see default-sort.test.ts under test_resolvers for
 * the end-to-end pagination).
 */

import { jest } from '@jest/globals';
import type { GraphQLError } from 'graphql';
import type { FieldMetadata } from '../../../src/utils/metadata-mapping.js';
import type { LoadersCollection } from '../../../src/loaders/index.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

const mockWarn = jest.fn();

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
  createContextLogger: () => ({
    error: jest.fn(),
    warn: mockWarn,
    info: jest.fn(),
    debug: jest.fn(),
    database: jest.fn(),
  }),
}));

// ─── Import dynamique ──────────────────────────────────────────────────────────

let resolveEffectiveSort: typeof import('../../../src/utils/default-sort.js').resolveEffectiveSort;
let resetWithoutKeyWarnings: typeof import('../../../src/utils/default-sort.js').resetWithoutKeyWarnings;
let ALL_COLUMNS_SORT: typeof import('../../../src/utils/default-sort.js').ALL_COLUMNS_SORT;

beforeAll(async () => {
  ({ resolveEffectiveSort, resetWithoutKeyWarnings, ALL_COLUMNS_SORT } =
    await import('../../../src/utils/default-sort.js'));
});

beforeEach(() => {
  mockWarn.mockClear();
  resetWithoutKeyWarnings();
});

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Builds the metadata row of a column.
 *
 * @param name - Column name.
 * @param isPrimaryKey - Whether the column is part of the logical key.
 * @returns A FieldMetadata with neutral values for the other attributes.
 */
// Ligne de metadata minimale
const field = (name: string, isPrimaryKey = false): FieldMetadata => ({
  name,
  label: name,
  sqlType: 'VARCHAR',
  isPrimaryKey,
  isCategorical: false,
  parentName: null,
  labelFor: null,
  labelFields: [],
  unit: null,
  displayFormat: null,
  family: null,
  description: null,
  defaultAggregation: null,
});

/**
 * Fakes the two loaders the sort resolution reads.
 *
 * @param fields - Metadata rows, in table order.
 * @param clusterBy - Decoded `dataset_metadata.cluster_by`.
 * @returns The fake loaders collection.
 */
// Loaders factices : metadata et dataset_metadata
const loadersOf = (fields: FieldMetadata[], clusterBy: string[] = []): LoadersCollection =>
  ({
    catalogMetadata: { load: async () => fields },
    datasetInfo: { load: async () => ({ clusterBy }) },
  }) as unknown as LoadersCollection;

/** Table without any primary key: three columns, no cluster_by. */
const NO_KEY = [field('label'), field('observed_on'), field('amount')];

// ─── Sans tri explicite ───────────────────────────────────────────────────────

describe('resolveEffectiveSort — no explicit sort', () => {
  test('follows cluster_by when it names existing columns', async () => {
    const loaders = loadersOf([field('a', true), field('b', true), field('c')], ['b', 'a']);

    await expect(resolveEffectiveSort(null, loaders, 'cat', 'main')).resolves.toEqual([
      { field: 'b', order: 'ASC' },
      { field: 'a', order: 'ASC' },
    ]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('falls back on the primary keys when cluster_by is empty or stale', async () => {
    const fields = [field('a', true), field('b'), field('c', true)];
    const expected = [
      { field: 'a', order: 'ASC' },
      { field: 'c', order: 'ASC' },
    ];

    await expect(resolveEffectiveSort([], loadersOf(fields), 'cat', 'main')).resolves.toEqual(
      expected,
    );
    // cluster_by ne nomme plus que des colonnes supprimées
    await expect(
      resolveEffectiveSort(undefined, loadersOf(fields, ['dropped']), 'cat', 'main'),
    ).resolves.toEqual(expected);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('falls back on ORDER BY ALL when there is no cluster_by and no primary key', async () => {
    const sort = await resolveEffectiveSort(null, loadersOf(NO_KEY), 'cat', 'main');

    expect(sort).toEqual([ALL_COLUMNS_SORT]);
  });

  test('a stale cluster_by without primary key still ends on ORDER BY ALL', async () => {
    const sort = await resolveEffectiveSort(null, loadersOf(NO_KEY, ['dropped']), 'cat', 'main');

    expect(sort).toEqual([ALL_COLUMNS_SORT]);
  });

  test('warns once per schema, not once per query', async () => {
    const loaders = loadersOf(NO_KEY);

    await resolveEffectiveSort(null, loaders, 'cat', 'main');
    await resolveEffectiveSort(null, loaders, 'cat', 'main');
    await resolveEffectiveSort(null, loaders, 'cat', 'main');
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('cat.main'),
      expect.objectContaining({ catalog: 'cat', schema: 'main' }),
    );

    // Un autre schéma, ou un autre catalogue, a son propre avertissement
    await resolveEffectiveSort(null, loaders, 'cat', 'other');
    await resolveEffectiveSort(null, loaders, 'cat2', 'main');
    expect(mockWarn).toHaveBeenCalledTimes(3);
  });
});

// ─── Avec tri explicite ───────────────────────────────────────────────────────

describe('resolveEffectiveSort — explicit sort', () => {
  test('appends the primary keys not already named', async () => {
    const loaders = loadersOf([field('a', true), field('b', true), field('c')]);

    await expect(
      resolveEffectiveSort([{ field: 'c', order: 'DESC' }], loaders, 'cat', 'main'),
    ).resolves.toEqual([
      { field: 'c', order: 'DESC' },
      { field: 'a', order: 'ASC' },
      { field: 'b', order: 'ASC' },
    ]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('without primary key, appends every other column in table order', async () => {
    // ORDER BY ALL ne peut pas suivre un tri explicite : les colonnes sont listées
    const sort = await resolveEffectiveSort(
      [{ field: 'observed_on', order: 'DESC' }],
      loadersOf(NO_KEY),
      'cat',
      'main',
    );

    expect(sort).toEqual([
      { field: 'observed_on', order: 'DESC' },
      { field: 'label', order: 'ASC' },
      { field: 'amount', order: 'ASC' },
    ]);
    expect(sort).not.toContainEqual(ALL_COLUMNS_SORT);
  });

  test('without primary key, warns once per schema as well', async () => {
    const loaders = loadersOf(NO_KEY);

    await resolveEffectiveSort([{ field: 'label', order: 'ASC' }], loaders, 'cat', 'main');
    await resolveEffectiveSort([{ field: 'amount', order: 'ASC' }], loaders, 'cat', 'main');
    await resolveEffectiveSort(null, loaders, 'cat', 'main');

    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  test('rejects an unknown sort column', async () => {
    let caught: unknown;
    try {
      await resolveEffectiveSort(
        [{ field: 'nope', order: 'ASC' }],
        loadersOf(NO_KEY),
        'cat',
        'main',
      );
    } catch (error) {
      caught = error;
    }

    expect((caught as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
  });

  test('the empty field of the ORDER BY ALL item is not a valid client sort column', async () => {
    // Le sentinelle ne peut pas être forgé par un client : « '' » n'est pas une colonne
    await expect(
      resolveEffectiveSort([ALL_COLUMNS_SORT], loadersOf(NO_KEY), 'cat', 'main'),
    ).rejects.toThrow();
  });
});
