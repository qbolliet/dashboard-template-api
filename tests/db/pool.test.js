// Unit tests for DuckDBPool (src/db/pool.js)
// Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
import { jest } from '@jest/globals';

// ─── Mock state ───────────────────────────────────────────────────────────────

const mockQueryResult = {
  getRowObjectsJson: jest.fn().mockResolvedValue([{ id: 1, value: 'test' }]),
  getRowsJson:       jest.fn().mockResolvedValue([[1, 'test']]),
  columnNames:       jest.fn().mockReturnValue(['id', 'value'])
};

const mockDuckConn = {
  run:       jest.fn().mockResolvedValue(mockQueryResult),
  prepare:   jest.fn(),
  closeSync: jest.fn()
};

const mockInstance = {
  connect:   jest.fn().mockResolvedValue(mockDuckConn),
  closeSync: jest.fn()
};

jest.unstable_mockModule('@duckdb/node-api', () => ({
  DuckDBInstance: { create: jest.fn().mockResolvedValue(mockInstance) }
}));

jest.unstable_mockModule('../../src/utils/config-loader.js', () => ({
  config: { S3: { ENABLED: false } }
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  createContextLogger: () => ({ database: jest.fn(), error: jest.fn(), warn: jest.fn() })
}));

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let DuckDBPool;
let DuckDBInstance;

beforeAll(async () => {
  ({ DuckDBPool }      = await import('../../src/db/pool.js'));
  ({ DuckDBInstance }  = await import('@duckdb/node-api'));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeCatalogs = () => [
  { alias: 'main', path: '/abs/main.ducklake', dataPath: '/abs/data/main/', readOnly: true }
];

const makePool = (overrides = {}) => new DuckDBPool({
  catalogs:       makeCatalogs(),
  maxConnections: 3,
  acquireTimeout: 500,
  retryDelay:     20,
  ...overrides
});

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
    mockDuckConn.prepare.mockImplementation(() =>
      Promise.resolve({
        bindNull:    jest.fn(),
        bindVarchar: jest.fn(),
        bindInteger: jest.fn(),
        bindDouble:  jest.fn(),
        bindBoolean: jest.fn(),
        run:         jest.fn().mockResolvedValue(mockQueryResult)
      })
    );
  });

  // ── Constructor ───────────────────────────────────────────────────────────

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
      const catalogs = [
        { alias: 'a', path: '/a.ducklake', dataPath: '/data_a/', readOnly: true },
        { alias: 'b', path: '/b.ducklake', dataPath: '/data_b/', readOnly: false }
      ];
      expect(makePool({ catalogs }).catalogs).toEqual(catalogs);
    });

    test('instance and instancePromise start as null', () => {
      const pool = makePool();
      expect(pool.instance).toBeNull();
      expect(pool.instancePromise).toBeNull();
    });
  });

  // ── initializeInstance ────────────────────────────────────────────────────

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
      const attachCalls = mockDuckConn.run.mock.calls.filter(([sql]) => sql.includes('ATTACH'));
      expect(attachCalls).toHaveLength(1);
      expect(attachCalls[0][0]).toContain('"main"');
    });

    test('includes DATA_PATH option in ATTACH when dataPath is set', async () => {
      await makePool().initializeInstance();
      const [attachSql] = mockDuckConn.run.mock.calls.find(([sql]) => sql.includes('ATTACH'));
      expect(attachSql).toContain('DATA_PATH');
    });

    test('includes READ_ONLY option in ATTACH for read-only catalogs', async () => {
      await makePool().initializeInstance();
      const [attachSql] = mockDuckConn.run.mock.calls.find(([sql]) => sql.includes('ATTACH'));
      expect(attachSql).toContain('READ_ONLY');
    });

    test('lazy singleton — concurrent calls share one DuckDB instance', async () => {
      const pool = makePool();
      const [i1, i2, i3] = await Promise.all([
        pool.initializeInstance(),
        pool.initializeInstance(),
        pool.initializeInstance()
      ]);
      expect(i1).toBe(i2);
      expect(i2).toBe(i3);
      expect(DuckDBInstance.create).toHaveBeenCalledTimes(1);
    });

    test('returns the cached instance on subsequent calls', async () => {
      const pool   = makePool();
      const first  = await pool.initializeInstance();
      const second = await pool.initializeInstance();
      expect(first).toBe(second);
      expect(DuckDBInstance.create).toHaveBeenCalledTimes(1);
    });

    test('does not configure S3 when S3.ENABLED is false', async () => {
      await makePool().initializeInstance();
      const sqlCalls = mockDuckConn.run.mock.calls.map(([sql]) => sql);
      expect(sqlCalls.some(s => s.includes('httpfs'))).toBe(false);
    });
  });

  // ── acquire ───────────────────────────────────────────────────────────────

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
      const pool  = makePool();
      const conn1 = await pool.acquire();
      pool.release(conn1);
      const conn2 = await pool.acquire();
      expect(conn2).toBe(conn1);
      expect(pool.pool).toHaveLength(1);
    });

    test('creates up to maxConnections distinct connections', async () => {
      const pool  = makePool({ maxConnections: 2 });
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

  // ── release ───────────────────────────────────────────────────────────────

  describe('release', () => {
    test('marks connection as no longer in use', async () => {
      const pool = makePool();
      const conn = await pool.acquire();
      expect(conn.inUse).toBe(true);
      pool.release(conn);
      expect(pool.pool[0].inUse).toBe(false);
    });

    test('allows the released connection to be reacquired', async () => {
      const pool  = makePool({ maxConnections: 1 });
      const conn1 = await pool.acquire();
      pool.release(conn1);
      const conn2 = await pool.acquire();
      expect(conn2).toBe(conn1);
    });

    test('silently ignores unknown connections', () => {
      expect(() => makePool().release({ conn: {} })).not.toThrow();
    });
  });

  // ── close ─────────────────────────────────────────────────────────────────

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
  });

  // ── Connection query methods ──────────────────────────────────────────────

  describe('Connection query methods', () => {
    let pool;
    let conn;

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
        const mockPrep = {
          bindVarchar: jest.fn(),
          bindInteger: jest.fn(),
          bindDouble:  jest.fn(),
          bindBoolean: jest.fn(),
          bindNull:    jest.fn(),
          run:         jest.fn().mockResolvedValue(mockQueryResult)
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
        const mockPrep = { bindVarchar: jest.fn(), run: jest.fn().mockResolvedValue(mockQueryResult) };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', ['hello']);
        expect(mockPrep.bindVarchar).toHaveBeenCalledWith(1, 'hello');
      });

      test('binds integer param with bindInteger', async () => {
        const mockPrep = { bindInteger: jest.fn(), run: jest.fn().mockResolvedValue(mockQueryResult) };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', [7]);
        expect(mockPrep.bindInteger).toHaveBeenCalledWith(1, 7);
      });

      test('binds float param with bindDouble', async () => {
        const mockPrep = { bindDouble: jest.fn(), run: jest.fn().mockResolvedValue(mockQueryResult) };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', [3.14]);
        expect(mockPrep.bindDouble).toHaveBeenCalledWith(1, 3.14);
      });

      test('binds boolean param with bindBoolean', async () => {
        const mockPrep = { bindBoolean: jest.fn(), run: jest.fn().mockResolvedValue(mockQueryResult) };
        mockDuckConn.prepare.mockResolvedValue(mockPrep);
        await conn.all('SELECT ?', [true]);
        expect(mockPrep.bindBoolean).toHaveBeenCalledWith(1, true);
      });

      test('converts unknown param types to string', async () => {
        const mockPrep = { bindVarchar: jest.fn(), run: jest.fn().mockResolvedValue(mockQueryResult) };
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
        const mockPrep = {
          bindInteger: jest.fn(),
          run:         jest.fn().mockResolvedValue(mockQueryResult)
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
          { id: 3, score: 30 }
        ]);
        mockQueryResult.columnNames.mockReturnValue(['id', 'score']);

        const { metadata } = await conn.getWithMetadata('SELECT id, score FROM t');
        expect(metadata.extents.score).toEqual([10, 50]);
        expect(metadata.extents.id).toEqual([1, 3]);
      });

      test('skips null values when computing extents', async () => {
        mockQueryResult.getRowObjectsJson.mockResolvedValue([
          { v: 5 }, { v: null }, { v: 15 }
        ]);
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
