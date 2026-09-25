/**
 * Unit tests for FieldStatsLoader (src/loaders/field-stats.ts).
 *
 * Verifies the single SQL query (aggregates, qualified table, parameterized
 * filter), the identifier validation, the mapping of the row, the two cache
 * TTLs (long unfiltered, short filtered), the cache key layout covered by the
 * invalidation by prefix, and that two loads of the same key run one query.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import {
  makeLoaderConfig,
  makePool,
  makeConnection,
  makeDatabaseManager,
} from '../../helpers/mocks.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Statistiques renvoyées par le loader. */
interface StatsResult {
  min: unknown;
  max: unknown;
  distinctCount: number;
  nullCount: number;
}

/** Clé du loader : colonne et filtre compilé optionnel. */
interface StatsKey {
  fieldName: string;
  where?: { sql: string; params: unknown[] } | null;
}

/** Instance d'un loader DataLoader — interface minimale. */
interface DataLoaderInstance {
  load: (key: StatsKey) => Promise<StatsResult>;
}

/** Module field-stats.ts après import dynamique. */
interface FieldStatsModule {
  createFieldStatsLoader: (catalog?: string | null, schema?: string | null) => DataLoaderInstance;
}

// ─── État des mocks partagés ───────────────────────────────────────────────────

const mockPool = makePool();
const mockConnection = makeConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

// Cache Redis simulé : une Map, et l'enregistrement des clés et TTL demandés
const cacheStore = new Map<string, unknown>();
const cacheCalls: Array<{ key: string; ttl: number }> = [];

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));

jest.unstable_mockModule('../../../src/utils/cache.js', () => ({
  withCache: jest.fn().mockImplementation(async (key: unknown, fn: unknown, ttl: unknown) => {
    cacheCalls.push({ key: key as string, ttl: ttl as number });
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

let createFieldStatsLoader: FieldStatsModule['createFieldStatsLoader'];

beforeAll(async () => {
  ({ createFieldStatsLoader } =
    (await import('../../../src/loaders/field-stats.js')) as unknown as FieldStatsModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FieldStatsLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheStore.clear();
    cacheCalls.length = 0;
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultCatalog.mockReturnValue('main');
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
    mockConnection.all.mockResolvedValue([
      { min_value: 1, max_value: 9, distinct_count: 5, null_count: 2 },
    ]);
  });

  test('renvoie min, max, distinctCount et nullCount de la ligne lue', async () => {
    const loader = createFieldStatsLoader('db1', 'main');
    const stats = await loader.load({ fieldName: 'value' });

    expect(stats).toEqual({ min: 1, max: 9, distinctCount: 5, nullCount: 2 });
  });

  test('émet une seule requête agrégée sur la fact_table qualifiée', async () => {
    const loader = createFieldStatsLoader('db1', 'geo');
    await loader.load({ fieldName: 'population' });

    expect(mockConnection.all).toHaveBeenCalledTimes(1);
    const [query, params] = mockConnection.all.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('MIN(population)');
    expect(query).toContain('MAX(population)');
    expect(query).toContain('COUNT(DISTINCT population)');
    expect(query).toContain('COUNT(*) - COUNT(population)');
    expect(query).toContain('"db1".geo.fact_table');
    expect(query).not.toContain('WHERE');
    expect(params).toEqual([]);
  });

  test('borne le filtre compilé en paramètres, sans le concaténer', async () => {
    const loader = createFieldStatsLoader('db1', 'main');
    await loader.load({
      fieldName: 'value',
      where: { sql: '"country" = ?', params: ["Côte-d'Or"] },
    });

    const [query, params] = mockConnection.all.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('WHERE "country" = ?');
    expect(query).not.toContain('Côte');
    expect(params).toEqual(["Côte-d'Or"]);
  });

  test('colonne vide : min et max restent null', async () => {
    mockConnection.all.mockResolvedValue([
      { min_value: null, max_value: null, distinct_count: 0, null_count: 0 },
    ]);

    const loader = createFieldStatsLoader('db1', 'main');
    const stats = await loader.load({ fieldName: 'value' });

    expect(stats).toEqual({ min: null, max: null, distinctCount: 0, nullCount: 0 });
  });

  test.each(['value; DROP TABLE fact_table', '1abc', 'a-b', '"quoted"', ''])(
    "rejette l'identifiant invalide %j avant toute requête",
    async (fieldName) => {
      const loader = createFieldStatsLoader('db1', 'main');

      await expect(loader.load({ fieldName })).rejects.toThrow(GraphQLError);
      expect(mockConnection.all).not.toHaveBeenCalled();
    },
  );

  describe('cache', () => {
    test('deux chargements de la même clé exécutent une seule requête SQL', async () => {
      // Deux loaders distincts : deux requêtes GraphQL qui ne partagent que Redis
      const first = createFieldStatsLoader('db1', 'main');
      const second = createFieldStatsLoader('db1', 'main');

      const a = await first.load({ fieldName: 'value' });
      const b = await second.load({ fieldName: 'value' });

      expect(b).toEqual(a);
      expect(mockConnection.all).toHaveBeenCalledTimes(1);
    });

    test("une clé filtrée ne partage pas l'entrée de la variante non filtrée", async () => {
      const loader = createFieldStatsLoader('db1', 'main');

      await loader.load({ fieldName: 'value' });
      await loader.load({ fieldName: 'value', where: { sql: '"kind" = ?', params: ['Actual'] } });
      await loader.load({ fieldName: 'value', where: { sql: '"kind" = ?', params: ['Forecast'] } });

      expect(mockConnection.all).toHaveBeenCalledTimes(3);
      expect(new Set(cacheCalls.map((c) => c.key)).size).toBe(3);
    });

    test('TTL long sans filtre (select options), court avec filtre (faits)', async () => {
      const loader = createFieldStatsLoader('db1', 'main');

      await loader.load({ fieldName: 'value' });
      await loader.load({ fieldName: 'value', where: { sql: '"kind" = ?', params: ['Actual'] } });

      const { SELECT_OPTIONS_CACHE_TIMEOUT, FACT_CACHE_TIMEOUT } = mockConfig.API.LOADERS;
      expect(SELECT_OPTIONS_CACHE_TIMEOUT).not.toBe(FACT_CACHE_TIMEOUT);
      expect(cacheCalls[0].ttl).toBe(SELECT_OPTIONS_CACHE_TIMEOUT);
      expect(cacheCalls[1].ttl).toBe(FACT_CACHE_TIMEOUT);
    });

    test('la clé suit le motif field-stats:<catalogue>:<schéma>: des invalidations', async () => {
      const loader = createFieldStatsLoader('db1', 'geo');
      await loader.load({ fieldName: 'population' });

      expect(cacheCalls[0].key.startsWith('field-stats:db1:geo:')).toBe(true);
    });

    test('un schéma non fixé occupe le segment « _ » de la clé', async () => {
      const loader = createFieldStatsLoader('db1');
      await loader.load({ fieldName: 'population' });

      expect(cacheCalls[0].key.startsWith('field-stats:db1:_:')).toBe(true);
    });
  });
});
