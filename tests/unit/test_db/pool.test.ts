/**
 * Unit tests for DuckDBPool (src/db/pool.js).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks @duckdb/node-api, config-loader, and logger to isolate pool logic.
 * Covers constructor, initializeInstance, acquire, release, close,
 * and all connection query methods (all, getAsJsonArray, getWithMetadata, exec).
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Résultat de requête mocké — simulation de DuckDBQueryResult. */
interface MockQueryResult {
  getRowObjectsJson: jest.Mock;
  getRowsJson: jest.Mock;
  columnNames: jest.Mock;
}

/** Connexion DuckDB mockée — simulation de DuckDBConnection. */
interface MockDuckConnection {
  run: jest.Mock;
  prepare: jest.Mock;
  closeSync: jest.Mock;
}

/** Instance DuckDB mockée — simulation de DuckDBInstance. */
interface MockDuckInstance {
  connect: jest.Mock;
  closeSync: jest.Mock;
}

/** Statement préparé mocké — retourné par mockDuckConn.prepare(). */
interface MockPreparedStatement {
  bindNull: jest.Mock;
  bindVarchar: jest.Mock;
  bindInteger: jest.Mock;
  bindDouble: jest.Mock;
  bindBoolean: jest.Mock;
  run: jest.Mock;
}

/** Configuration passée au constructeur DuckDBPool. */
interface PoolConfig {
  catalogs: CatalogConfig[];
  maxConnections: number;
  acquireTimeout: number;
  retryDelay: number;
  drainTimeout?: number;
}

/** Configuration d'un catalogue DuckLake attaché au pool. */
interface CatalogConfig {
  alias: string;
  path: string;
  dataPath: string;
  readOnly: boolean;
}

/** Instance de DuckDBPool avec accès aux membres internes pour les tests. */
interface DuckDBPoolInstance {
  maxConnections: number;
  acquireTimeout: number;
  retryDelay: number;
  pool: PoolEntry[];
  draining: PoolEntry[];
  catalogs: CatalogConfig[];
  instance: MockDuckInstance | null;
  instancePromise: Promise<MockDuckInstance> | null;
  initializeInstance: () => Promise<MockDuckInstance>;
  reload: () => Promise<void>;
  acquire: () => Promise<PoolEntry>;
  release: (conn: PoolEntry) => void;
  close: () => Promise<void>;
}

/** Entrée dans le tableau pool — connexion avec flag d'utilisation. */
interface PoolEntry {
  conn: MockDuckConnection;
  inUse: boolean;
  all: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  getAsJsonArray: (sql: string, params?: unknown[]) => Promise<unknown[][]>;
  getWithMetadata: (sql: string, params?: unknown[]) => Promise<QueryWithMetadata>;
  exec: (sql: string) => Promise<void>;
  close: () => Promise<void>;
}

/** Résultat enrichi de getWithMetadata — données + colonnes + métadonnées. */
interface QueryWithMetadata {
  columns: string[];
  data: unknown[];
  metadata: {
    count: number;
    extents: Record<string, [number, number]>;
  };
}

/** Module DuckDBPool après import dynamique. */
interface PoolModule {
  DuckDBPool: new (config: PoolConfig) => DuckDBPoolInstance;
}

/** Module @duckdb/node-api après import dynamique. */
interface DuckDBNodeApiModule {
  DuckDBInstance: {
    create: jest.Mock;
  };
}

// ─── État des mocks ───────────────────────────────────────────────────────────

// Résultat de requête mocké — utilisé par toutes les méthodes de connexion
const mockQueryResult: MockQueryResult = {
  getRowObjectsJson: jest.fn().mockResolvedValue([{ id: 1, value: 'test' }]),
  getRowsJson: jest.fn().mockResolvedValue([[1, 'test']]),
  columnNames: jest.fn().mockReturnValue(['id', 'value']),
};

// Connexion DuckDB mockée — simulation de l'objet retourné par instance.connect()
const mockDuckConn: MockDuckConnection = {
  run: jest.fn().mockResolvedValue(mockQueryResult),
  prepare: jest.fn(),
  closeSync: jest.fn(),
};

// Instance DuckDB mockée — simulation de l'objet retourné par DuckDBInstance.create()
const mockInstance: MockDuckInstance = {
  connect: jest.fn().mockResolvedValue(mockDuckConn),
  closeSync: jest.fn(),
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('@duckdb/node-api', () => ({
  DuckDBInstance: { create: jest.fn().mockResolvedValue(mockInstance) },
}));

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: { S3: { ENABLED: false } },
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => ({ database: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

// ─── Imports dynamiques ───────────────────────────────────────────────────────

let DuckDBPool: new (config: PoolConfig) => DuckDBPoolInstance;
let DuckDBInstance: { create: jest.Mock };

beforeAll(async () => {
  ({ DuckDBPool } = (await import('../../../src/db/pool.js')) as unknown as PoolModule);
  ({ DuckDBInstance } = (await import('@duckdb/node-api')) as unknown as DuckDBNodeApiModule);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the default catalog list used in most tests.
 *
 * Returns:
 *     Array with a single read-only 'main' catalog.
 */
const makeCatalogs = (): CatalogConfig[] => [
  { alias: 'main', path: '/abs/main.ducklake', dataPath: '/abs/data/main/', readOnly: true },
];

/**
 * Create a DuckDBPool instance with sensible defaults for testing.
 *
 * Args:
 *     overrides: Partial PoolConfig values to override the defaults.
 *
 * Returns:
 *     A configured DuckDBPool instance ready for testing.
 */
const makePool = (overrides: Partial<PoolConfig> = {}): DuckDBPoolInstance =>
  new DuckDBPool({
    catalogs: makeCatalogs(),
    maxConnections: 3,
    acquireTimeout: 500,
    retryDelay: 20,
    ...overrides,
  });

/**
 * Build a distinct mock DuckDB instance whose connect() yields a fresh
 * connection on each call.
 *
 * Lets a test tell the old instance apart from the rebuilt one across a reload
 * (the shared mockInstance cannot be distinguished from itself).
 *
 * Returns:
 *     A standalone MockDuckInstance with its own closeSync spy.
 */
const makeFreshInstance = (): MockDuckInstance => {
  const makeConn = (): MockDuckConnection => ({
    run: jest.fn().mockResolvedValue(mockQueryResult),
    prepare: jest.fn(),
    closeSync: jest.fn(),
  });
  return {
    connect: jest.fn().mockImplementation(() => Promise.resolve(makeConn())),
    closeSync: jest.fn(),
  };
};

/**
 * Poll a predicate until it returns true or the timeout elapses.
 *
 * Args:
 *     predicate: Condition to wait for.
 *     timeoutMs: Maximum time to wait before throwing.
 */
const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error('waitFor: condition not met within timeout');
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DuckDBPool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    DuckDBInstance.create.mockResolvedValue(mockInstance);
    mockInstance.connect.mockResolvedValue(mockDuckConn);
    mockDuckConn.run.mockResolvedValue(mockQueryResult);
    mockDuckConn.closeSync.mockReset();
    mockInstance.closeSync.mockReset();
    mockQueryResult.getRowObjectsJson.mockResolvedValue([{ id: 1, value: 'test' }]);
    mockQueryResult.getRowsJson.mockResolvedValue([[1, 'test']]);
    mockQueryResult.columnNames.mockReturnValue(['id', 'value']);
    // Statement préparé par défaut — méthodes de binding et run
    mockDuckConn.prepare.mockImplementation(() =>
      Promise.resolve<MockPreparedStatement>({
        bindNull: jest.fn(),
        bindVarchar: jest.fn(),
        bindInteger: jest.fn(),
        bindDouble: jest.fn(),
        bindBoolean: jest.fn(),
        run: jest.fn().mockResolvedValue(mockQueryResult),
      }),
    );
  });

  // ── Constructeur ──────────────────────────────────────────────────────────

  describe('Constructor', () => {
    test('sets maxConnections from config', () => {
      const pool = makePool({ maxConnections: 10 });
      expect(pool.maxConnections).toBe(10);
    });

    test('sets acquireTimeout from config', () => {
      const pool = makePool({ acquireTimeout: 9999 });
      expect(pool.acquireTimeout).toBe(9999);
    });

    test('sets retryDelay from config', () => {
      const pool = makePool({ retryDelay: 75 });
      expect(pool.retryDelay).toBe(75);
    });

    test('starts with an empty pool', () => {
      expect(makePool().pool).toHaveLength(0);
    });

    test('stores catalogs from config', () => {
      const catalogs: CatalogConfig[] = [
        { alias: 'a', path: '/a.ducklake', dataPath: '/data_a/', readOnly: true },
        { alias: 'b', path: '/b.ducklake', dataPath: '/data_b/', readOnly: false },
      ];
      expect(makePool({ catalogs }).catalogs).toEqual(catalogs);
    });

    test('instance and instancePromise start as null', () => {
      const pool = makePool();
      expect(pool.instance).toBeNull();
      expect(pool.instancePromise).toBeNull();
    });
  });

  // ── Initialisation de l'instance DuckDB ───────────────────────────────────

  describe('initializeInstance', () => {
    test('creates an in-memory DuckDB instance', async () => {
      await makePool().initializeInstance();
      expect(DuckDBInstance.create).toHaveBeenCalledWith(':memory:');
    });

    test('loads the ducklake extension', async () => {
      await makePool().initializeInstance();
      expect(mockDuckConn.run).toHaveBeenCalledWith('LOAD ducklake;');
    });

    test('attaches each catalog with ATTACH', async () => {
      await makePool().initializeInstance();
      const attachCalls = mockDuckConn.run.mock.calls.filter(([sql]) =>
        (sql as string).includes('ATTACH'),
      );
      expect(attachCalls).toHaveLength(1);
      expect(attachCalls[0][0]).toContain('"main"');
    });

    test('includes DATA_PATH option in ATTACH when dataPath is set', async () => {
      await makePool().initializeInstance();
      const attachCall = mockDuckConn.run.mock.calls.find(([sql]) =>
        (sql as string).includes('ATTACH'),
      );
      const [attachSql] = attachCall as [string];
      expect(attachSql).toContain('DATA_PATH');
    });

    test('includes READ_ONLY option in ATTACH for read-only catalogs', async () => {
      await makePool().initializeInstance();
      const attachCall = mockDuckConn.run.mock.calls.find(([sql]) =>
        (sql as string).includes('ATTACH'),
      );
      const [attachSql] = attachCall as [string];
      expect(attachSql).toContain('READ_ONLY');
    });

    test('lazy singleton — concurrent calls share one DuckDB instance', async () => {
      const pool = makePool();
      const [i1, i2, i3] = await Promise.all([
        pool.initializeInstance(),
        pool.initializeInstance(),
        pool.initializeInstance(),
      ]);
      expect(i1).toBe(i2);
      expect(i2).toBe(i3);
      expect(DuckDBInstance.create).toHaveBeenCalledTimes(1);
    });

    test('returns the cached instance on subsequent calls', async () => {
      const pool = makePool();
      const first = await pool.initializeInstance();
      const second = await pool.initializeInstance();
      expect(first).toBe(second);
      expect(DuckDBInstance.create).toHaveBeenCalledTimes(1);
    });

    test('does not configure S3 when S3.ENABLED is false', async () => {
      await makePool().initializeInstance();
      const sqlCalls = mockDuckConn.run.mock.calls.map(([sql]) => sql as string);
      expect(sqlCalls.some((s) => s.includes('httpfs'))).toBe(false);
    });

    test('clears instancePromise on failure so a later call can retry', async () => {
      const pool = makePool();
      DuckDBInstance.create.mockRejectedValueOnce(new Error('init failed'));

      await expect(pool.initializeInstance()).rejects.toThrow('init failed');
      // La Promise rejetée ne doit pas rester en cache (sinon le pool est cassé)
      expect(pool.instancePromise).toBeNull();

      // Nouvelle tentative réussie (retour au mock par défaut)
      await expect(pool.initializeInstance()).resolves.toBe(mockInstance);
    });
  });

  // ── Acquisition de connexion ──────────────────────────────────────────────

  describe('acquire', () => {
    test('creates a new connection when pool is empty', async () => {
      const pool = makePool();
      const conn = await pool.acquire();
      expect(conn).toBeDefined();
      expect(conn.inUse).toBe(true);
      expect(pool.pool).toHaveLength(1);
    });

    test('returned connection has all, getAsJsonArray, getWithMetadata, exec methods', async () => {
      const conn = await makePool().acquire();
      expect(typeof conn.all).toBe('function');
      expect(typeof conn.getAsJsonArray).toBe('function');
      expect(typeof conn.getWithMetadata).toBe('function');
      expect(typeof conn.exec).toBe('function');
    });

    test('reuses an available connection', async () => {
      const pool = makePool();
      const conn1 = await pool.acquire();
      pool.release(conn1);
      const conn2 = await pool.acquire();
      expect(conn2).toBe(conn1);
      expect(pool.pool).toHaveLength(1);
    });

    test('creates up to maxConnections distinct connections', async () => {
      const pool = makePool({ maxConnections: 2 });
      const conn1 = await pool.acquire();
      const conn2 = await pool.acquire();
      expect(pool.pool).toHaveLength(2);
      expect(conn1).not.toBe(conn2);
    });

    test('times out when pool is full and no connection is freed', async () => {
      const pool = makePool({ maxConnections: 1, acquireTimeout: 100, retryDelay: 20 });
      await pool.acquire();
      await expect(pool.acquire()).rejects.toThrow('Connection acquisition timeout');
    }, 5000);
  });

  // ── Libération de connexion ───────────────────────────────────────────────

  describe('release', () => {
    test('marks connection as no longer in use', async () => {
      const pool = makePool();
      const conn = await pool.acquire();
      expect(conn.inUse).toBe(true);
      pool.release(conn);
      expect(pool.pool[0].inUse).toBe(false);
    });

    test('allows the released connection to be reacquired', async () => {
      const pool = makePool({ maxConnections: 1 });
      const conn1 = await pool.acquire();
      pool.release(conn1);
      const conn2 = await pool.acquire();
      expect(conn2).toBe(conn1);
    });

    test('silently ignores unknown connections', () => {
      expect(() => makePool().release({ conn: {} } as PoolEntry)).not.toThrow();
    });
  });

  // ── Fermeture du pool ─────────────────────────────────────────────────────

  describe('close', () => {
    test('resolves without error when pool is empty', async () => {
      await expect(makePool().close()).resolves.toBeUndefined();
    });

    test('closes each connection in the pool', async () => {
      const pool = makePool();
      const conn = await pool.acquire();
      pool.release(conn);
      await pool.close();
      expect(mockDuckConn.closeSync).toHaveBeenCalled();
    });

    test('closes the shared DuckDB instance', async () => {
      const pool = makePool();
      await pool.acquire();
      pool.release(pool.pool[0]);
      await pool.close();
      expect(mockInstance.closeSync).toHaveBeenCalled();
    });

    test('resets pool array, instance and instancePromise', async () => {
      const pool = makePool();
      await pool.acquire();
      pool.release(pool.pool[0]);
      await pool.close();
      expect(pool.pool).toHaveLength(0);
      expect(pool.instance).toBeNull();
      expect(pool.instancePromise).toBeNull();
    });

    test('also closes connections left draining by a reload', async () => {
      const instA = makeFreshInstance();
      const instB = makeFreshInstance();
      DuckDBInstance.create.mockResolvedValueOnce(instA).mockResolvedValueOnce(instB);

      // drainTimeout long → la connexion en vol reste en drainage pendant le close
      const pool = makePool({ retryDelay: 10, drainTimeout: 5000 });
      const oldConn = await pool.acquire(); // inUse, jamais relâchée
      await pool.reload();

      expect(pool.draining).toHaveLength(1);
      const closeSpy = jest.spyOn(oldConn, 'close');

      await pool.close();

      expect(closeSpy).toHaveBeenCalled();
      expect(pool.draining).toHaveLength(0);

      // Laisse la boucle de drainage résiduelle se terminer proprement
      oldConn.inUse = false;
    });
  });

  // ── Rechargement de l'instance (reload) ───────────────────────────────────

  describe('reload', () => {
    test('rebuilds the instance and re-attaches catalogs', async () => {
      const pool = makePool();
      await pool.initializeInstance();
      const attachBefore = mockDuckConn.run.mock.calls.filter(([sql]) =>
        (sql as string).includes('ATTACH'),
      ).length;

      await pool.reload();

      const attachAfter = mockDuckConn.run.mock.calls.filter(([sql]) =>
        (sql as string).includes('ATTACH'),
      ).length;
      expect(attachAfter).toBeGreaterThan(attachBefore);
      expect(DuckDBInstance.create).toHaveBeenCalledTimes(2);
    });

    test('swaps in the new instance for subsequent acquisitions', async () => {
      const instA = makeFreshInstance();
      const instB = makeFreshInstance();
      DuckDBInstance.create.mockResolvedValueOnce(instA).mockResolvedValueOnce(instB);

      const pool = makePool();
      await pool.initializeInstance();
      expect(pool.instance).toBe(instA);

      await pool.reload();
      expect(pool.instance).toBe(instB);

      await pool.acquire();
      expect(instB.connect).toHaveBeenCalled();
    });

    test('keeps the old instance serving when the rebuild fails', async () => {
      const pool = makePool();
      await pool.initializeInstance();
      const oldInstance = pool.instance;

      DuckDBInstance.create.mockRejectedValueOnce(new Error('S3 unreachable'));
      await expect(pool.reload()).rejects.toThrow('S3 unreachable');

      // L'ancienne instance reste en place et le pool reste fonctionnel
      expect(pool.instance).toBe(oldInstance);
      await expect(pool.initializeInstance()).resolves.toBe(oldInstance);
    });

    test('dedupes concurrent reloads into a single rebuild', async () => {
      const pool = makePool();
      await pool.initializeInstance();
      const before = DuckDBInstance.create.mock.calls.length;

      await Promise.all([pool.reload(), pool.reload(), pool.reload()]);

      expect(DuckDBInstance.create.mock.calls.length).toBe(before + 1);
    });

    test('drains in-flight connections before closing the old instance', async () => {
      const instA = makeFreshInstance();
      const instB = makeFreshInstance();
      DuckDBInstance.create.mockResolvedValueOnce(instA).mockResolvedValueOnce(instB);

      const pool = makePool({ retryDelay: 10 });
      const oldConn = await pool.acquire();
      const closeSpy = jest.spyOn(oldConn, 'close');
      expect(oldConn.inUse).toBe(true);

      await pool.reload();

      // Requête encore en vol → l'ancienne instance ne doit pas être fermée
      expect(instA.closeSync).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();

      // Fin de la requête → le drainage ferme la connexion puis l'instance
      pool.release(oldConn);
      await waitFor(() => (instA.closeSync as jest.Mock).mock.calls.length > 0);

      expect(closeSpy).toHaveBeenCalled();
      expect(instA.closeSync).toHaveBeenCalled();
    });

    test('force-closes in-flight connections after the drain timeout', async () => {
      const instA = makeFreshInstance();
      const instB = makeFreshInstance();
      DuckDBInstance.create.mockResolvedValueOnce(instA).mockResolvedValueOnce(instB);

      // drainTimeout court → fermeture forcée sans attendre 30s
      const pool = makePool({ retryDelay: 10, drainTimeout: 30 });
      const oldConn = await pool.acquire(); // jamais relâchée
      const closeSpy = jest.spyOn(oldConn, 'close');

      await pool.reload();

      await waitFor(() => (instA.closeSync as jest.Mock).mock.calls.length > 0);
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  // ── Libération d'une connexion en drainage ────────────────────────────────

  describe('release (draining connections)', () => {
    test('marks a draining connection free after a reload', async () => {
      const instA = makeFreshInstance();
      const instB = makeFreshInstance();
      DuckDBInstance.create.mockResolvedValueOnce(instA).mockResolvedValueOnce(instB);

      const pool = makePool({ retryDelay: 10, drainTimeout: 5000 });
      const oldConn = await pool.acquire();
      await pool.reload();

      expect(pool.draining).toContain(oldConn);
      expect(oldConn.inUse).toBe(true);

      pool.release(oldConn);
      expect(oldConn.inUse).toBe(false);
    });
  });

  // ── Méthodes de requête des connexions ────────────────────────────────────

  describe('Connection query methods', () => {
    let pool: DuckDBPoolInstance;
    let conn: PoolEntry;

    beforeEach(async () => {
      pool = makePool();
      conn = await pool.acquire();
    });

    afterEach(() => pool.release(conn));

    // ── all ──

    describe('all', () => {
      test('executes plain query and returns row objects', async () => {
        const rows = await conn.all('SELECT * FROM main.main.tbl');
        expect(mockDuckConn.run).toHaveBeenCalledWith('SELECT * FROM main.main.tbl');
        expect(rows).toEqual([{ id: 1, value: 'test' }]);
      });

      test('uses prepared statement for parameterized queries', async () => {
        const mockPrep: MockPreparedStatement = {
          bindVarchar: jest.fn(),
          bindInteger: jest.fn(),
          bindDouble: jest.fn(),
          bindBoolean: jest.fn(),
          bindNull: jest.fn(),
          run: jest.fn().mockResolvedValue(mockQueryResult),
        };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);

        await conn.all('SELECT * FROM t WHERE id = ?', [42]);

        expect(mockDuckConn.prepare).toHaveBeenCalledWith('SELECT * FROM t WHERE id = ?');
        expect(mockPrep.bindInteger).toHaveBeenCalledWith(1, 42);
      });

      test('binds null param with bindNull', async () => {
        const mockPrep = { bindNull: jest.fn(), run: jest.fn().mockResolvedValue(mockQueryResult) };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', [null]);
        expect(mockPrep.bindNull).toHaveBeenCalledWith(1);
      });

      test('binds string param with bindVarchar', async () => {
        const mockPrep = {
          bindVarchar: jest.fn(),
          run: jest.fn().mockResolvedValue(mockQueryResult),
        };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', ['hello']);
        expect(mockPrep.bindVarchar).toHaveBeenCalledWith(1, 'hello');
      });

      test('binds integer param with bindInteger', async () => {
        const mockPrep = {
          bindInteger: jest.fn(),
          run: jest.fn().mockResolvedValue(mockQueryResult),
        };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', [7]);
        expect(mockPrep.bindInteger).toHaveBeenCalledWith(1, 7);
      });

      test('binds float param with bindDouble', async () => {
        const mockPrep = {
          bindDouble: jest.fn(),
          run: jest.fn().mockResolvedValue(mockQueryResult),
        };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', [3.14]);
        expect(mockPrep.bindDouble).toHaveBeenCalledWith(1, 3.14);
      });

      test('binds boolean param with bindBoolean', async () => {
        const mockPrep = {
          bindBoolean: jest.fn(),
          run: jest.fn().mockResolvedValue(mockQueryResult),
        };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', [true]);
        expect(mockPrep.bindBoolean).toHaveBeenCalledWith(1, true);
      });

      test('converts unknown param types to string', async () => {
        const mockPrep = {
          bindVarchar: jest.fn(),
          run: jest.fn().mockResolvedValue(mockQueryResult),
        };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', [{ key: 'val' }]);
        expect(mockPrep.bindVarchar).toHaveBeenCalledWith(1, '[object Object]');
      });
    });

    // ── getAsJsonArray ──

    describe('getAsJsonArray', () => {
      test('returns rows as arrays (not objects)', async () => {
        const rows = await conn.getAsJsonArray('SELECT id FROM main.main.tbl');
        expect(rows).toEqual([[1, 'test']]);
        expect(mockQueryResult.getRowsJson).toHaveBeenCalled();
      });

      test('uses prepared statement for parameterized queries', async () => {
        const mockPrep: Partial<MockPreparedStatement> = {
          bindInteger: jest.fn(),
          run: jest.fn().mockResolvedValue(mockQueryResult),
        };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.getAsJsonArray('SELECT ? AS n', [1]);
        expect(mockDuckConn.prepare).toHaveBeenCalled();
        expect(mockPrep.bindInteger).toHaveBeenCalledWith(1, 1);
      });
    });

    // ── getWithMetadata ──

    describe('getWithMetadata', () => {
      test('returns columns, data, and metadata', async () => {
        const result = await conn.getWithMetadata('SELECT id, value FROM main.main.tbl');
        expect(result.columns).toEqual(['id', 'value']);
        expect(result.data).toEqual([{ id: 1, value: 'test' }]);
        expect(result.metadata.count).toBe(1);
      });

      test('computes numeric extents for numeric columns', async () => {
        mockQueryResult.getRowObjectsJson.mockResolvedValue([
          { id: 1, score: 10 },
          { id: 2, score: 50 },
          { id: 3, score: 30 },
        ]);
        mockQueryResult.columnNames.mockReturnValue(['id', 'score']);

        const { metadata } = await conn.getWithMetadata('SELECT id, score FROM t');
        expect(metadata.extents.score).toEqual([10, 50]);
        expect(metadata.extents.id).toEqual([1, 3]);
      });

      test('skips null values when computing extents', async () => {
        mockQueryResult.getRowObjectsJson.mockResolvedValue([{ v: 5 }, { v: null }, { v: 15 }]);
        mockQueryResult.columnNames.mockReturnValue(['v']);

        const { metadata } = await conn.getWithMetadata('SELECT v FROM t');
        expect(metadata.extents.v).toEqual([5, 15]);
      });

      test('excludes non-numeric columns from extents', async () => {
        mockQueryResult.getRowObjectsJson.mockResolvedValue([{ name: 'alice' }, { name: 'bob' }]);
        mockQueryResult.columnNames.mockReturnValue(['name']);

        const { metadata } = await conn.getWithMetadata('SELECT name FROM t');
        expect(metadata.extents).not.toHaveProperty('name');
      });
    });

    // ── exec ──

    describe('exec', () => {
      test('executes query without returning results', async () => {
        await conn.exec('SET memory_limit = "1GB"');
        expect(mockDuckConn.run).toHaveBeenCalledWith('SET memory_limit = "1GB"');
      });

      test('resolves to undefined', async () => {
        await expect(conn.exec('SET enable_progress_bar = false')).resolves.toBeUndefined();
      });
    });
  });
});
