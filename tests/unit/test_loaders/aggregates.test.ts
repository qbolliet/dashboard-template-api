/**
 * Unit tests for AggregatesLoader (src/loaders/aggregates.ts).
 *
 * Verifies that a page runs ONE SQL query holding every aggregate, that the
 * column types and extents come back with the rows, that the group count is
 * a separate query under its own cache variant, and that the cache key follows
 * the resolved parameters: two orders of the same aggregates are two entries,
 * the same parameters one entry.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import {
  makeLoaderConfig,
  makePool,
  makeExtendedConnection,
  makeDatabaseManager,
} from '../../helpers/mocks.js';
import type {
  AggregatePageParams,
  AggregateCountParams,
} from '../../../src/utils/aggregate-query.js';
import type { AggregatePage } from '../../../src/loaders/aggregates.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Instance d'un loader DataLoader — interface minimale. */
interface DataLoaderInstance<K, V> {
  load: (key: K) => Promise<V>;
}

/** Module aggregates.ts après import dynamique. */
interface AggregatesModule {
  createAggregatesLoader: (
    catalog?: string | null,
    schema?: string | null,
  ) => DataLoaderInstance<AggregatePageParams, AggregatePage>;
  createAggregateGroupCountLoader: (
    catalog?: string | null,
    schema?: string | null,
  ) => DataLoaderInstance<AggregateCountParams, number>;
}

// ─── État des mocks partagés ───────────────────────────────────────────────────

const mockPool = makePool();
const mockConnection = makeExtendedConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

// Cache Redis simulé : une Map, et l'enregistrement des clés demandées
const cacheStore = new Map<string, unknown>();
const cacheKeys: string[] = [];

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));

jest.unstable_mockModule('../../../src/utils/cache.js', () => ({
  withCache: jest.fn().mockImplementation(async (key: unknown, fn: unknown) => {
    cacheKeys.push(key as string);
    if (cacheStore.has(key as string)) return cacheStore.get(key as string);
    const value = await (fn as () => Promise<unknown>)();
    cacheStore.set(key as string, value);
    return value;
  }),
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  createContextLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    database: jest.fn(),
  }),
}));

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

let createAggregatesLoader: AggregatesModule['createAggregatesLoader'];
let createAggregateGroupCountLoader: AggregatesModule['createAggregateGroupCountLoader'];

beforeAll(async () => {
  ({ createAggregatesLoader, createAggregateGroupCountLoader } =
    (await import('../../../src/loaders/aggregates.js')) as unknown as AggregatesModule);
});

// ─── Données ──────────────────────────────────────────────────────────────────

const SUM = { measure: 'value', aggregation: 'SUM', alias: 'value_sum' } as const;
const AVG = { measure: 'value', aggregation: 'AVG', alias: 'value_avg' } as const;
const COUNTRY = { field: 'country', grain: null, truncation: null, labelField: null };

/**
 * Builds page parameters.
 *
 * @param aggregates - Aggregates, in order.
 * @returns Resolved page parameters on the country group.
 */
// Paramètres d'une page sur la colonne country
const pageParams = (aggregates: AggregatePageParams['aggregates']): AggregatePageParams => ({
  groups: [COUNTRY],
  aggregates,
  sort: [{ by: 'country', order: 'ASC' }],
  includeRowCount: true,
  where: { sql: '"kind" = ?', params: ['Actual'] },
  limit: 10,
  offset: 0,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AggregatesLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheStore.clear();
    cacheKeys.length = 0;
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockPool.acquire.mockResolvedValue(mockConnection);
    mockConnection.getWithMetadata.mockResolvedValue({
      columns: ['country', 'value_sum', 'value_avg', 'row_count'],
      columnTypes: ['VARCHAR', 'DOUBLE', 'DOUBLE', 'BIGINT'],
      data: [{ country: 'France', value_sum: 10, value_avg: 2, row_count: 5 }],
      metadata: { count: 1, extents: { value_sum: [10, 10] } },
    });
    mockConnection.all.mockResolvedValue([{ total: 7 }]);
  });

  test('une page = une requête SQL portant tous les agrégats', async () => {
    const page = await createAggregatesLoader('db1', 'main').load(pageParams([SUM, AVG]));

    expect(mockConnection.getWithMetadata).toHaveBeenCalledTimes(1);
    expect(mockConnection.all).not.toHaveBeenCalled();
    const [sql, values] = mockConnection.getWithMetadata.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SUM("value") AS "value_sum"');
    expect(sql).toContain('AVG("value") AS "value_avg"');
    expect(sql).toContain('"db1"."main"."fact_table"');
    expect(sql).toContain('WHERE "kind" = ?');
    expect(values).toEqual(['Actual']);

    expect(page).toEqual({
      columns: ['country', 'value_sum', 'value_avg', 'row_count'],
      columnTypes: ['VARCHAR', 'DOUBLE', 'DOUBLE', 'BIGINT'],
      data: [{ country: 'France', value_sum: 10, value_avg: 2, row_count: 5 }],
      extents: { value_sum: [10, 10] },
    });
  });

  test('le comptage des groupes est une requête distincte, sous la variante count', async () => {
    const total = await createAggregateGroupCountLoader('db1', 'main').load({
      groups: [COUNTRY],
      where: null,
    });

    expect(total).toBe(7);
    expect(mockConnection.all).toHaveBeenCalledTimes(1);
    const [sql] = mockConnection.all.mock.calls[0] as [string];
    expect(sql).toBe(
      'SELECT COUNT(*) AS total FROM (SELECT 1 FROM "db1"."main"."fact_table" GROUP BY "country")',
    );
    expect(cacheKeys[0]).toMatch(/^aggregated-facts:db1:main@v1:count/);
  });

  test('deux ordres d’agrégats donnent deux entrées de cache', async () => {
    await createAggregatesLoader('db1', 'main').load(pageParams([SUM, AVG]));
    await createAggregatesLoader('db1', 'main').load(pageParams([AVG, SUM]));

    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
    expect(mockConnection.getWithMetadata).toHaveBeenCalledTimes(2);
    // Préfixe couvert par le motif d'invalidation des agrégats
    expect(cacheKeys.every((key) => key.startsWith('aggregated-facts:db1:main@v1:'))).toBe(true);
  });

  test('les mêmes paramètres résolus partagent une entrée', async () => {
    await createAggregatesLoader('db1', 'main').load(pageParams([SUM, AVG]));
    await createAggregatesLoader('db1', 'main').load(pageParams([SUM, AVG]));

    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).toBe(cacheKeys[1]);
    // Seconde lecture servie par le cache : une seule requête
    expect(mockConnection.getWithMetadata).toHaveBeenCalledTimes(1);
  });

  test('l’agrégation effective entre dans la clé', async () => {
    await createAggregatesLoader('db1', 'main').load(pageParams([SUM]));
    await createAggregatesLoader('db1', 'main').load(
      pageParams([{ measure: 'value', aggregation: 'AVG', alias: 'value_sum' }]),
    );

    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });
});
