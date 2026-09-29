/**
 * Unit tests for BaseQueryLoader and FactQueryLoader (src/loaders/base-loader.ts).
 *
 * Verifies constructor defaults, connection lifecycle in executeWithConnection,
 * table qualification logic, cache key generation in loadWithCache, and the
 * propagation of load errors by the DataLoaders (never a silent null).
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  makeLoaderConfig,
  makePool,
  makeExtendedConnection,
  makeDatabaseManager,
} from '../../helpers/mocks.js';

/**
 * Recomputes the cache key `loadWithCache` is expected to build, mirroring
 * base-loader.ts's canonicalization (sorted keys, undefined dropped) and sha1
 * hashing, so tests don't hardcode an opaque hash.
 *
 * @param prefix - Loader's cachePrefix.
 * @param catalog - Resolved catalog segment.
 * @param schema - Resolved schema segment.
 * @param key - The raw DataLoader key passed to loadWithCache.
 * @param version - Served data version (mock: 'v1').
 * @returns The expected `<prefix>:<catalog>:<schema>@<version>:<hash>` cache key.
 */
function expectedCacheKey(
  prefix: string,
  catalog: string,
  schema: string,
  key: unknown,
  version = 'v1',
): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const propertyKey of Object.keys(source).sort()) {
        if (source[propertyKey] !== undefined)
          sorted[propertyKey] = canonicalize(source[propertyKey]);
      }
      return sorted;
    }
    return value;
  };
  const keyForHash =
    key !== null && typeof key === 'object' && !Array.isArray(key)
      ? { ...(key as Record<string, unknown>), catalog, schema }
      : { key, catalog, schema };
  const hash = createHash('sha1')
    .update(JSON.stringify(canonicalize(keyForHash)))
    .digest('hex');
  return `${prefix}:${catalog}:${schema}@${version}:${hash}`;
}

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Instance d'un BaseQueryLoader — méthodes publiques testées. */
interface BaseQueryLoaderInstance {
  batchSize: number;
  cachePrefix: string;
  cacheEnabled: boolean;
  catalogId: string | null;
  schema: string | null;
  cacheTimeout: number;
  queryTimeout: number;
  executeWithConnection: (fn: (conn: unknown) => Promise<unknown>) => Promise<unknown>;
  qualifyTable: (tableName: string) => string;
  loadWithCache: (key: unknown, loaderFn: () => Promise<unknown>) => Promise<unknown>;
  createLoader: <K, V>(
    loadFn: (connection: unknown, key: K) => Promise<V>,
  ) => { load: (key: K) => Promise<V> };
  createBatchLoader: <K, V>(
    batchLoadFn: (connection: unknown, keys: readonly K[]) => Promise<(V | null)[]>,
  ) => { load: (key: K) => Promise<V> };
}

/** Options de construction d'un BaseQueryLoader. */
interface BaseQueryLoaderOptions {
  batchSize?: number;
  cachePrefix?: string;
  cache?: boolean;
  catalogId?: string | null;
  schema?: string | null;
  cacheTimeout?: number;
  queryTimeout?: number;
}

/** Constructeur de BaseQueryLoader. */
interface BaseQueryLoaderConstructor {
  new (options?: BaseQueryLoaderOptions): BaseQueryLoaderInstance;
}

/** Instance d'un FactQueryLoader — méthodes de construction de clauses SQL. */
interface FactQueryLoaderInstance {
  buildSelectClause: (fields: string[] | null) => string;
  buildSortClause: (sort: Array<{ field: string; order: string }> | null) => string;
}

/** Constructeur de FactQueryLoader. */
interface FactQueryLoaderConstructor {
  new (): FactQueryLoaderInstance;
}

/** Module base-loader.ts après import dynamique. */
interface BaseLoaderModule {
  BaseQueryLoader: BaseQueryLoaderConstructor;
  FactQueryLoader: FactQueryLoaderConstructor;
}

// ─── État des mocks partagés ───────────────────────────────────────────────────

// Connexion et pool réutilisés dans tous les tests du fichier
const mockPool = makePool();
const mockConnection = makeExtendedConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

const mockWithCache = jest.fn();
const mockLogger = {
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));

jest.unstable_mockModule('../../../src/utils/cache.js', () => ({
  withCache: mockWithCache,
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: mockLogger,
  // La garde de version (db/schema-version.js) crée son propre logger contextuel
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

// Déclarations avant beforeAll — remplies après résolution des mocks
let BaseQueryLoader: BaseQueryLoaderConstructor;
let FactQueryLoader: FactQueryLoaderConstructor;

beforeAll(async () => {
  ({ BaseQueryLoader, FactQueryLoader } =
    (await import('../../../src/loaders/base-loader.js')) as unknown as BaseLoaderModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BaseQueryLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockDatabaseManager.getDefaultCatalog.mockReturnValue('main');
    mockDatabaseManager.getDataVersion.mockReturnValue('v1');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Constructeur ──────────────────────────────────────────────────────────

  describe('Constructor', () => {
    test('initialise avec la configuration par défaut', () => {
      const loader = new BaseQueryLoader();
      expect(loader.batchSize).toBe(5);
      expect(loader.cachePrefix).toBe('default');
      expect(loader.cacheEnabled).toBe(true);
      expect(loader.catalogId).toBeNull();
      expect(loader.cacheTimeout).toBe(300000);
      // Échéance par défaut : le plus long timeout de resolver (FACT_COMPLEX)
      expect(loader.queryTimeout).toBe(15000);
    });

    test('initialise avec une configuration personnalisée', () => {
      const loader = new BaseQueryLoader({
        batchSize: 15,
        cachePrefix: 'custom',
        cache: false,
        catalogId: 'analytics',
        cacheTimeout: 99999,
      });
      expect(loader.batchSize).toBe(15);
      expect(loader.cachePrefix).toBe('custom');
      expect(loader.cacheEnabled).toBe(false);
      expect(loader.catalogId).toBe('analytics');
      expect(loader.cacheTimeout).toBe(99999);
    });

    test('cache activé par défaut même si non spécifié', () => {
      const loader = new BaseQueryLoader({ cache: undefined });
      expect(loader.cacheEnabled).toBe(true);
    });

    test('cache désactivé quand cache: false', () => {
      const loader = new BaseQueryLoader({ cache: false });
      expect(loader.cacheEnabled).toBe(false);
    });
  });

  // ── Gestion du cycle de vie des connexions ────────────────────────────────

  describe('executeWithConnection', () => {
    test('acquiert et libère la connexion correctement', async () => {
      const loader = new BaseQueryLoader({ catalogId: 'main' });
      const queryFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');

      const result = await loader.executeWithConnection(queryFn);

      expect(mockDatabaseManager.getPool).toHaveBeenCalledWith('main');
      expect(mockPool.acquire).toHaveBeenCalled();
      expect(queryFn).toHaveBeenCalledWith(mockConnection);
      expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
      expect(result).toBe('result');
    });

    test("libère la connexion même en cas d'erreur de la requête", async () => {
      const loader = new BaseQueryLoader();
      const queryFn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error('Query failed'));

      await expect(loader.executeWithConnection(queryFn)).rejects.toThrow('Query failed');
      expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
    });

    test("ne libère pas la connexion si l'acquisition échoue", async () => {
      const loader = new BaseQueryLoader();
      mockPool.acquire.mockRejectedValue(new Error('Pool exhausted'));
      const queryFn = jest.fn();

      await expect(loader.executeWithConnection(queryFn)).rejects.toThrow('Pool exhausted');
      expect(mockPool.release).not.toHaveBeenCalled();
      expect(queryFn).not.toHaveBeenCalled();
    });

    test('utilise null comme catalogId par défaut', async () => {
      const loader = new BaseQueryLoader({ catalogId: null });
      const queryFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');

      await loader.executeWithConnection(queryFn);
      expect(mockDatabaseManager.getPool).toHaveBeenCalledWith(null);
    });

    test('gère plusieurs opérations concurrentes', async () => {
      const loader = new BaseQueryLoader();
      const ops = Array.from({ length: 5 }, (_, i) =>
        loader.executeWithConnection(async () => `result-${i}`),
      );

      const results = await Promise.all(ops);
      expect(results).toHaveLength(5);
      expect(mockPool.acquire).toHaveBeenCalledTimes(5);
      expect(mockPool.release).toHaveBeenCalledTimes(5);
    });

    test("passe un signal d'annulation à l'acquisition", async () => {
      const loader = new BaseQueryLoader();
      await loader.executeWithConnection(async () => 'ok');
      expect(mockPool.acquire).toHaveBeenCalledWith(expect.any(AbortSignal));
    });
  });

  // ── Connexion à la demande : cache consulté avant le pool ─────────────────

  describe('createLoader — cache avant connexion', () => {
    test('un hit de cache ne prend aucune connexion', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'hit', catalogId: 'main' });
      mockWithCache.mockImplementation(async () => 'cached');
      const loadFn = jest.fn<() => Promise<string>>().mockResolvedValue('db');
      const dataLoader = loader.createLoader<string, string>(loadFn);

      await expect(dataLoader.load('k')).resolves.toBe('cached');
      expect(mockPool.acquire).not.toHaveBeenCalled();
      expect(mockPool.release).not.toHaveBeenCalled();
      expect(loadFn).not.toHaveBeenCalled();
    });

    test('les absences de cache d’un lot partagent une seule connexion', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'mix', catalogId: 'main' });
      // Premier appel : hit ; les suivants : absence, chargement en base
      mockWithCache
        .mockImplementationOnce(async () => 'cached')
        .mockImplementation(async (_key: unknown, fn: () => Promise<unknown>) => await fn());
      const dataLoader = loader.createLoader<string, string>(async (_conn, key) => `db:${key}`);

      const results = await Promise.all([
        dataLoader.load('a'),
        dataLoader.load('b'),
        dataLoader.load('c'),
      ]);

      expect(results).toEqual(['cached', 'db:b', 'db:c']);
      expect(mockPool.acquire).toHaveBeenCalledTimes(1);
      expect(mockPool.release).toHaveBeenCalledTimes(1);
      expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
    });

    test('un chargement en échec est appelé une seule fois', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'fail', catalogId: 'main' });
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );
      const loadFn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('IO Error: x'));
      const dataLoader = loader.createLoader<string, string>(loadFn);

      await expect(dataLoader.load('k')).rejects.toThrow('IO Error: x');
      expect(loadFn).toHaveBeenCalledTimes(1);
      expect(mockPool.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── Échéance du lot : interruption de la requête ──────────────────────────

  describe('queryTimeout', () => {
    test('interrompt la requête en cours puis libère la connexion', async () => {
      // Requête bloquée jusqu'à l'interruption DuckDB, qui la fait échouer
      let failQuery: (error: Error) => void = () => undefined;
      const interrupt = jest.fn(() => failQuery(new Error('INTERRUPT Error: Interrupted!')));
      const connection = { conn: { interrupt } };
      mockPool.acquire.mockResolvedValue(connection);
      const loader = new BaseQueryLoader({ cachePrefix: 'slow', queryTimeout: 30 });

      const started = Date.now();
      await expect(
        loader.executeWithConnection(
          () =>
            new Promise((_resolve, reject) => {
              failQuery = reject;
            }),
        ),
      ).rejects.toThrow('slow query timeout after 30ms');

      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(mockPool.release).toHaveBeenCalledWith(connection);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    test("quitte la file d'attente du pool à l'échéance, sans libération", async () => {
      // Acquisition en file : seule l'annulation du signal la termine
      mockPool.acquire.mockImplementation(
        (signal: unknown) =>
          new Promise((_resolve, reject) => {
            const abortSignal = signal as AbortSignal;
            abortSignal.addEventListener('abort', () => reject(abortSignal.reason));
          }),
      );
      const loader = new BaseQueryLoader({ cachePrefix: 'queued', queryTimeout: 30 });
      const queryFn = jest.fn();

      await expect(loader.executeWithConnection(queryFn)).rejects.toThrow(
        'queued query timeout after 30ms',
      );
      expect(queryFn).not.toHaveBeenCalled();
      expect(mockPool.release).not.toHaveBeenCalled();
    });

    test("une requête terminée avant l'échéance n'est pas interrompue", async () => {
      const interrupt = jest.fn();
      const connection = { conn: { interrupt } };
      mockPool.acquire.mockResolvedValue(connection);
      const loader = new BaseQueryLoader({ queryTimeout: 30 });

      await expect(loader.executeWithConnection(async () => 'fast')).resolves.toBe('fast');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(interrupt).not.toHaveBeenCalled();
    });
  });

  // ── Qualification des noms de tables ──────────────────────────────────────

  describe('qualifyTable', () => {
    test('utilise catalogId quand il est défini', () => {
      const loader = new BaseQueryLoader({ catalogId: 'mydb' });
      mockDatabaseManager.getDefaultSchema.mockReturnValue('main');

      const result = loader.qualifyTable('fact_table');
      expect(result).toBe('"mydb"."main"."fact_table"');
      expect(mockDatabaseManager.getDefaultSchema).toHaveBeenCalledWith('mydb');
    });

    test('utilise defaultDatabase quand catalogId est null', () => {
      const loader = new BaseQueryLoader({ catalogId: null });
      mockDatabaseManager.getDefaultCatalog.mockReturnValue('defaultdb');
      mockDatabaseManager.getDefaultSchema.mockReturnValue('main');

      const result = loader.qualifyTable('metadata');
      expect(result).toBe('"defaultdb"."main"."metadata"');
    });

    test('quote catalogue, schéma et table, guillemets internes doublés', () => {
      const loader = new BaseQueryLoader({ catalogId: 'catalog1' });
      mockDatabaseManager.getDefaultSchema.mockReturnValue('mon "schéma"');

      const result = loader.qualifyTable('fact_table');
      expect(result).toBe('"catalog1"."mon ""schéma"""."fact_table"');
    });
  });

  // ── Propagation des erreurs par les DataLoaders ───────────────────────────

  describe('createLoader — propagation des erreurs', () => {
    test('une erreur du chargement rejette la clé au lieu de renvoyer null', async () => {
      const loader = new BaseQueryLoader({ cache: false });
      const dataLoader = loader.createLoader<string, string>(async () => {
        throw new Error('IO Error: S3 unreachable');
      });

      await expect(dataLoader.load('k')).rejects.toThrow('IO Error: S3 unreachable');
      expect(mockPool.release).toHaveBeenCalledWith(mockConnection);
    });

    test('seule la clé en échec est rejetée, les autres clés du lot aboutissent', async () => {
      const loader = new BaseQueryLoader({ cache: false });
      const dataLoader = loader.createLoader<string, string>(async (_conn, key) => {
        if (key === 'bad') throw new Error('boom');
        return `ok:${key}`;
      });

      // Même tick : les deux clés partent dans le même lot
      const [good, bad] = await Promise.allSettled([
        dataLoader.load('good'),
        dataLoader.load('bad'),
      ]);

      expect(good).toEqual({ status: 'fulfilled', value: 'ok:good' });
      expect(bad.status).toBe('rejected');
      expect((bad as PromiseRejectedResult).reason.message).toBe('boom');
    });

    test('une erreur de binder DuckDB due à la requête devient BAD_USER_INPUT', async () => {
      const loader = new BaseQueryLoader({ cache: false });
      const dataLoader = loader.createLoader<string, string>(async () => {
        throw new Error(
          'Binder Error: Referenced column "nope" not found in FROM clause!\n\nLINE 1: ...',
        );
      });

      await expect(dataLoader.load('k')).rejects.toMatchObject({
        message: 'Binder Error: Referenced column "nope" not found in FROM clause!',
        extensions: { code: 'BAD_USER_INPUT' },
      });
    });

    test('createBatchLoader rejette toutes les clés du lot sur erreur', async () => {
      const loader = new BaseQueryLoader({ cache: false });
      const dataLoader = loader.createBatchLoader<string, string>(async () => {
        throw new Error('IO Error: disk');
      });

      await expect(dataLoader.load('a')).rejects.toThrow('IO Error: disk');
    });

    test('createBatchLoader : une clé sans ligne vaut null (absence, pas erreur)', async () => {
      const loader = new BaseQueryLoader({ cache: false });
      const dataLoader = loader.createBatchLoader<string, string>(async () => ['x']);

      const [first, second] = await Promise.all([dataLoader.load('a'), dataLoader.load('b')]);
      expect(first).toBe('x');
      expect(second).toBeNull();
    });
  });

  // ── Chargement avec cache ─────────────────────────────────────────────────

  describe('loadWithCache', () => {
    test('appelle withCache quand le cache est activé', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'test', catalogId: 'main' });
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );

      const result = await loader.loadWithCache('mykey', loaderFn);

      // withCache distingue lui-même panne Redis et erreur du loader : il reçoit loaderFn.
      // Schéma résolu au défaut du catalogue (mock : 'main'), pas le placeholder '_'.
      expect(mockWithCache).toHaveBeenCalledWith(
        expectedCacheKey('test', 'main', 'main', 'mykey'),
        loaderFn,
        loader.cacheTimeout,
      );
      expect(loaderFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });

    test('contourne le cache quand désactivé', async () => {
      const loader = new BaseQueryLoader({ cache: false });
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('direct');

      const result = await loader.loadWithCache('key', loaderFn);

      expect(mockWithCache).not.toHaveBeenCalled();
      expect(loaderFn).toHaveBeenCalled();
      expect(result).toBe('direct');
    });

    test('un rejet de withCache remonte sans chargement direct supplémentaire', async () => {
      // Les pannes Redis sont absorbées par withCache : un rejet est une erreur
      // du loader, jamais rejouée ici
      const loader = new BaseQueryLoader({ cache: true });
      mockWithCache.mockRejectedValue(new Error('SQL error'));
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('never');

      await expect(loader.loadWithCache('key', loaderFn)).rejects.toThrow('SQL error');
      expect(loaderFn).not.toHaveBeenCalled();
    });

    test('une erreur du loader remonte sans second appel', async () => {
      const loader = new BaseQueryLoader({ cache: true });
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );
      const loaderFn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('SQL error'));

      // L'échec vient du chargement, pas du cache : pas de repli, pas de rejeu
      await expect(loader.loadWithCache('key', loaderFn)).rejects.toThrow('SQL error');
      expect(loaderFn).toHaveBeenCalledTimes(1);
    });

    test('génère la clé cache correcte pour un objet complexe', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'test', catalogId: 'main' });
      const complexKey = { field: 'value', nested: { prop: 123 } };
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );

      await loader.loadWithCache(complexKey, loaderFn);

      expect(mockWithCache).toHaveBeenCalledWith(
        expectedCacheKey('test', 'main', 'main', complexKey),
        expect.any(Function),
        loader.cacheTimeout,
      );
    });

    test('résout le catalogue et le schéma par défaut dans la clé cache quand catalogId est null', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'pre', catalogId: null });
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );

      await loader.loadWithCache('k', loaderFn);

      // catalogId: null → catalogue/schéma par défaut RÉSOLUS (mock : 'main'/'main'),
      // jamais les placeholders littéraux 'default'/'_' : sinon toute entrée de ce
      // loader collapserait sous la même clé quel que soit le catalogue réellement lu.
      expect(mockWithCache).toHaveBeenCalledWith(
        expectedCacheKey('pre', 'main', 'main', 'k'),
        expect.any(Function),
        expect.any(Number),
      );
    });

    test('la version des données servie entre dans la clé : une mise à jour la déplace', async () => {
      const loader = new BaseQueryLoader({ cachePrefix: 'facts', catalogId: 'main' });
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      mockWithCache.mockImplementation(
        async (_key: unknown, fn: () => Promise<unknown>) => await fn(),
      );

      await loader.loadWithCache('k', loaderFn);
      mockDatabaseManager.getDataVersion.mockReturnValue('v2');
      await loader.loadWithCache('k', loaderFn);

      const [before] = mockWithCache.mock.calls[0] as [string];
      const [after] = mockWithCache.mock.calls[1] as [string];
      expect(before).toBe(expectedCacheKey('facts', 'main', 'main', 'k', 'v1'));
      expect(after).toBe(expectedCacheKey('facts', 'main', 'main', 'k', 'v2'));
      // Version lue pour le (catalogue, schéma) résolu de la clé
      expect(mockDatabaseManager.getDataVersion).toHaveBeenCalledWith('main', 'main');
    });

    test('fait le fallback si JSON.stringify échoue (référence circulaire)', async () => {
      const loader = new BaseQueryLoader({ cache: true });
      // Clé circulaire — JSON.stringify lève une erreur, fallback vers le chargeur direct
      const circularKey: Record<string, unknown> = {};
      circularKey['self'] = circularKey;
      const loaderFn = jest.fn<() => Promise<string>>().mockResolvedValue('result');

      const result = await loader.loadWithCache(circularKey, loaderFn);
      expect(result).toBe('result');
      expect(loaderFn).toHaveBeenCalled();
    });
  });
});

// ─── FactQueryLoader ──────────────────────────────────────────────────────────

describe('FactQueryLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Construction de la clause SELECT ─────────────────────────────────────

  describe('buildSelectClause', () => {
    test('retourne * pour un tableau vide', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause([])).toBe('*');
    });

    test('retourne * pour null', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause(null)).toBe('*');
    });

    test('joint les champs quotés par virgule', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause(['id', 'name', 'value'])).toBe('"id", "name", "value"');
    });

    test('gère un seul champ', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause(['id'])).toBe('"id"');
    });

    test('accepte tout nom de colonne : espace, accent, guillemet', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSelectClause(['taux chômage', 'a"b'])).toBe('"taux chômage", "a""b"');
    });
  });

  // ── Construction de la clause ORDER BY ───────────────────────────────────

  describe('buildSortClause', () => {
    test('retourne une chaîne vide pour un tri vide', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSortClause([])).toBe('');
    });

    test('retourne une chaîne vide pour null', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSortClause(null)).toBe('');
    });

    test('construit la clause ORDER BY', () => {
      const loader = new FactQueryLoader();
      const result = loader.buildSortClause([
        { field: 'name', order: 'ASC' },
        { field: 'value', order: 'DESC' },
      ]);
      expect(result).toBe('ORDER BY "name" ASC, "value" DESC');
    });

    test('gère un seul critère de tri', () => {
      const loader = new FactQueryLoader();
      expect(loader.buildSortClause([{ field: 'id', order: 'ASC' }])).toBe('ORDER BY "id" ASC');
    });

    test('rend le tri « toutes les colonnes » (champ vide) en ORDER BY ALL', () => {
      // Dernier repli du tri par défaut : schéma sans cluster_by ni clé primaire
      const loader = new FactQueryLoader();
      expect(loader.buildSortClause([{ field: '', order: 'ASC' }])).toBe('ORDER BY ALL');
    });

    test('refuse une direction hors ASC / DESC', () => {
      const loader = new FactQueryLoader();
      expect(() => loader.buildSortClause([{ field: 'id', order: 'SIDEWAYS' }])).toThrow(
        'Sort order must be either "ASC" or "DESC"',
      );
    });
  });
});
