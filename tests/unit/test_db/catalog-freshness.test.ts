/**
 * Unit tests for the catalog freshness monitor (src/db/catalog-freshness.ts).
 *
 * The marker reader and the database layer are fakes: these tests cover the
 * decision logic (reload or not, warn, retry, no overlap, scheduling). The
 * DuckLake reader itself runs against a real catalog in
 * tests/integration/catalog-freshness.test.ts.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Version des données servie pour un schéma. */
interface DataVersion {
  version: string;
  updatedAt: string | null;
}

/** Résultat de lecture des marqueurs d'un catalogue. */
interface CatalogProbeResult {
  catalog: string;
  schemas: Record<string, { marker: DataVersion | null; error?: string }>;
  error?: string;
}

/** Cible factice : état servi modifiable et reload instrumenté. */
interface FakeTarget {
  served: Record<string, Record<string, string>>;
  getCatalogEntries: jest.Mock;
  getSchemas: jest.Mock;
  getDataVersion: jest.Mock;
  getDataVersions: jest.Mock;
  reloadCatalogs: jest.Mock;
}

/** Instance du moniteur — membres utilisés par les tests. */
interface MonitorInstance {
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
  tick: () => Promise<void>;
  probeNow: (options?: { forceReload?: boolean }) => Promise<{
    changed: string[];
    reloaded: boolean;
    versions: Record<string, Record<string, DataVersion>>;
  }>;
  getStatus: () => {
    enabled: boolean;
    intervalMs: number;
    lastReloadAt: string | null;
    lastReloadError: string | null;
    skippedTicks: number;
    catalogs: Record<
      string,
      {
        lastProbeAt: string | null;
        lastProbeOk: boolean | null;
        lastError: string | null;
        lastChangeAt: string | null;
        schemas: Record<
          string,
          { servedVersion: string; probedVersion: string | null; lastProbeAt: string | null }
        >;
      }
    >;
  };
}

/** Module catalog-freshness.ts après import dynamique. */
interface FreshnessModule {
  CatalogFreshnessMonitor: new (
    target: FakeTarget,
    reader: { readAll: jest.Mock },
    settings: { enabled: boolean; intervalMs: number },
  ) => MonitorInstance;
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockContextLogger = {
  database: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => mockContextLogger,
  logger: mockLogger,
}));
jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: { CATALOG_FRESHNESS: { ENABLED: false, INTERVAL_MS: 60000 }, S3: { ENABLED: false } },
}));
// Pas de DuckDB ni de configuration réelle : le singleton applicatif reçoit un stub
jest.unstable_mockModule('../../../src/db/database-manager.js', () => ({
  databaseManager: {},
  DATA_VERSION_SELECT: 'schema_version',
  NO_DATA_VERSION: 'none',
  toDataVersion: (row: Record<string, unknown> | undefined): DataVersion => ({
    version: row?.['data_version'] === undefined ? 'none' : String(row['data_version']),
    updatedAt: null,
  }),
}));
jest.unstable_mockModule('../../../src/db/pool.js', () => ({
  buildCatalogSql: jest.fn(() => []),
  createConfiguredInstance: jest.fn(),
}));

let CatalogFreshnessMonitor: FreshnessModule['CatalogFreshnessMonitor'];

beforeAll(async () => {
  ({ CatalogFreshnessMonitor } =
    (await import('../../../src/db/catalog-freshness.js')) as unknown as FreshnessModule);
});

// ─── Fabriques ────────────────────────────────────────────────────────────────

/**
 * Builds a fake database layer serving the given versions.
 *
 * Args:
 *     served: catalog → schema → served version.
 *     onReload: new served versions after a reload (default: unchanged).
 */
const makeTarget = (
  served: Record<string, Record<string, string>>,
  onReload?: () => Record<string, Record<string, string>>,
): FakeTarget => {
  const target: FakeTarget = {
    served,
    getCatalogEntries: jest.fn(() =>
      Object.keys(target.served).map((alias) => ({ alias, type: 'file', readOnly: true })),
    ),
    getSchemas: jest.fn((catalog: string) => Object.keys(target.served[catalog] ?? {})),
    getDataVersion: jest.fn(
      (catalog: string, schema: string) => target.served[catalog]?.[schema] ?? 'none',
    ),
    getDataVersions: jest.fn(() =>
      Object.fromEntries(
        Object.entries(target.served).map(([c, schemas]) => [
          c,
          Object.fromEntries(
            Object.entries(schemas).map(([s, v]) => [s, { version: v, updatedAt: null }]),
          ),
        ]),
      ),
    ),
    reloadCatalogs: jest.fn(async () => {
      if (onReload) target.served = onReload();
    }),
  };
  return target;
};

/**
 * Builds a reader returning the given markers (a string is a version, null an error).
 *
 * Args:
 *     markers: catalog → schema → version (null = unreadable), or an Error for the catalog.
 */
const makeReader = (
  markers: Record<string, Record<string, string | null> | Error>,
): { readAll: jest.Mock } => ({
  readAll: jest.fn(
    async (): Promise<CatalogProbeResult[]> =>
      Object.entries(markers).map(([catalog, value]) => {
        if (value instanceof Error) return { catalog, schemas: {}, error: value.message };
        return {
          catalog,
          schemas: Object.fromEntries(
            Object.entries(value).map(([schema, version]) => [
              schema,
              version === null
                ? { marker: null, error: 'IO Error: HTTP 503' }
                : { marker: { version, updatedAt: null } },
            ]),
          ),
        };
      }),
  ),
});

const settings = { enabled: true, intervalMs: 1000 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CatalogFreshnessMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('probeNow', () => {
    test('no change → no reload', async () => {
      const target = makeTarget({ default: { main: '1', trade: '5' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '1', trade: '5' } }),
        settings,
      );

      const outcome = await monitor.probeNow();

      expect(target.reloadCatalogs).not.toHaveBeenCalled();
      expect(outcome).toEqual(expect.objectContaining({ changed: [], reloaded: false }));
      const status = monitor.getStatus().catalogs['default'];
      expect(status.lastProbeOk).toBe(true);
      expect(status.lastProbeAt).toEqual(expect.any(String));
      expect(status.schemas['main']).toEqual(
        expect.objectContaining({ servedVersion: '1', probedVersion: '1' }),
      );
    });

    test('changed marker → one reload, then the new version is served', async () => {
      const target = makeTarget({ default: { main: '1' }, other: { main: '9' } }, () => ({
        default: { main: '2' },
        other: { main: '9' },
      }));
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '2' }, other: { main: '9' } }),
        settings,
      );

      const outcome = await monitor.probeNow();

      expect(target.reloadCatalogs).toHaveBeenCalledTimes(1);
      expect(outcome.changed).toEqual(['default']);
      expect(outcome.reloaded).toBe(true);
      expect(outcome.versions['default']['main'].version).toBe('2');
      const status = monitor.getStatus();
      expect(status.lastReloadAt).toEqual(expect.any(String));
      expect(status.catalogs['default'].lastChangeAt).toEqual(expect.any(String));
      expect(status.catalogs['default'].schemas['main'].servedVersion).toBe('2');
      expect(mockLogger.info).toHaveBeenCalledWith('Catalog update detected, reloading catalogs', {
        catalogs: ['default'],
      });
      // Version servie conforme à la sonde : aucun avertissement
      expect(mockContextLogger.warn).not.toHaveBeenCalled();
    });

    test('several changed catalogs → a single reload', async () => {
      const target = makeTarget({ a: { main: '1' }, b: { main: '1' } }, () => ({
        a: { main: '2' },
        b: { main: '2' },
      }));
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ a: { main: '2' }, b: { main: '2' } }),
        settings,
      );

      const outcome = await monitor.probeNow();

      expect(outcome.changed).toEqual(['a', 'b']);
      expect(target.reloadCatalogs).toHaveBeenCalledTimes(1);
    });

    test('catalog read error → no switch, warn log', async () => {
      const target = makeTarget({ default: { main: '1' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: new Error('HTTP 403 on s3://bucket/default.ducklake') }),
        settings,
      );

      const outcome = await monitor.probeNow();

      expect(target.reloadCatalogs).not.toHaveBeenCalled();
      expect(outcome.reloaded).toBe(false);
      expect(mockContextLogger.warn).toHaveBeenCalledWith(
        'Catalog freshness probe failed; keeping the served version',
        expect.objectContaining({ catalog: 'default', error: expect.stringContaining('403') }),
      );
      const status = monitor.getStatus().catalogs['default'];
      expect(status.lastProbeOk).toBe(false);
      expect(status.lastError).toContain('403');
      expect(status.schemas['main'].servedVersion).toBe('1');
    });

    test('unreadable schema marker → no switch for it, warn log', async () => {
      const target = makeTarget({ default: { main: '1' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: null } }),
        settings,
      );

      await monitor.probeNow();

      expect(target.reloadCatalogs).not.toHaveBeenCalled();
      expect(mockContextLogger.warn).toHaveBeenCalledWith(
        'Data marker unreadable; keeping the served version',
        expect.objectContaining({ catalog: 'default', schema: 'main' }),
      );
      expect(monitor.getStatus().catalogs['default'].lastProbeOk).toBe(false);
    });

    test('a schema served without version and still unreadable is not warned about', async () => {
      // Schéma sans dataset_metadata : refusé par la garde de version, déjà signalé
      const target = makeTarget({ default: { legacy: 'none' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { legacy: null } }),
        settings,
      );

      await monitor.probeNow();

      expect(target.reloadCatalogs).not.toHaveBeenCalled();
      expect(mockContextLogger.warn).not.toHaveBeenCalled();
      expect(monitor.getStatus().catalogs['default'].lastProbeOk).toBe(true);
    });

    test('a reader that throws counts as a failure of every catalog', async () => {
      const target = makeTarget({ a: { main: '1' }, b: { main: '1' } });
      const reader = { readAll: jest.fn(async () => Promise.reject(new Error('LOAD failed'))) };
      const monitor = new CatalogFreshnessMonitor(target, reader, settings);

      const outcome = await monitor.probeNow();

      expect(outcome.reloaded).toBe(false);
      expect(target.reloadCatalogs).not.toHaveBeenCalled();
      expect(mockContextLogger.warn).toHaveBeenCalledTimes(2);
    });

    test('failed reload → warn, versions unchanged, retried at the next probe', async () => {
      const target = makeTarget({ default: { main: '1' } }, () => ({ default: { main: '2' } }));
      target.reloadCatalogs.mockImplementationOnce(async () => {
        throw new Error('S3 unreachable');
      });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '2' } }),
        settings,
      );

      const first = await monitor.probeNow();
      expect(first.reloaded).toBe(false);
      expect(target.served['default']['main']).toBe('1');
      expect(monitor.getStatus().lastReloadError).toBe('S3 unreachable');
      expect(mockContextLogger.warn).toHaveBeenCalledWith(
        'Catalog reload after update failed; retrying at next probe',
        expect.objectContaining({ catalogs: ['default'], error: 'S3 unreachable' }),
      );

      // Le marqueur diffère toujours : nouvelle tentative, cette fois réussie
      const second = await monitor.probeNow();
      expect(second.reloaded).toBe(true);
      expect(target.reloadCatalogs).toHaveBeenCalledTimes(2);
      expect(target.served['default']['main']).toBe('2');
      expect(monitor.getStatus().lastReloadError).toBeNull();
    });

    test('reload serving another version than the probed one is warned about', async () => {
      // L'instance vivante voit encore l'ancien état après le reload
      const target = makeTarget({ default: { main: '1' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '2' } }),
        settings,
      );

      await monitor.probeNow();

      expect(target.reloadCatalogs).toHaveBeenCalledTimes(1);
      expect(mockContextLogger.warn).toHaveBeenCalledWith(
        'Reloaded catalog serves another version than the one probed',
        { catalog: 'default', schema: 'main', probed: '2', served: '1' },
      );
    });

    test('forceReload reloads even without change', async () => {
      const target = makeTarget({ default: { main: '1' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '1' } }),
        settings,
      );

      const outcome = await monitor.probeNow({ forceReload: true });

      expect(target.reloadCatalogs).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual(expect.objectContaining({ changed: [], reloaded: true }));
    });

    test('forceReload propagates a reload failure to the caller', async () => {
      const target = makeTarget({ default: { main: '1' } });
      target.reloadCatalogs.mockImplementationOnce(async () => {
        throw new Error('S3 unreachable');
      });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '1' } }),
        settings,
      );

      await expect(monitor.probeNow({ forceReload: true })).rejects.toThrow('S3 unreachable');
      // La file des sondes survit à l'échec
      await expect(monitor.probeNow()).resolves.toEqual(
        expect.objectContaining({ reloaded: false }),
      );
    });

    test('explicit probes are serialized, never concurrent', async () => {
      const target = makeTarget({ default: { main: '1' } });
      let active = 0;
      let maxActive = 0;
      const reader = {
        readAll: jest.fn(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return [
            {
              catalog: 'default',
              schemas: { main: { marker: { version: '1', updatedAt: null } } },
            },
          ];
        }),
      };
      const monitor = new CatalogFreshnessMonitor(target, reader, settings);

      await Promise.all([monitor.probeNow(), monitor.probeNow(), monitor.probeNow()]);

      expect(reader.readAll).toHaveBeenCalledTimes(3);
      expect(maxActive).toBe(1);
    });
  });

  describe('scheduling', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test('start() probes at every interval, stop() ends it', async () => {
      jest.useFakeTimers();
      const target = makeTarget({ default: { main: '1' } });
      const reader = makeReader({ default: { main: '1' } });
      const monitor = new CatalogFreshnessMonitor(target, reader, settings);

      monitor.start();
      expect(monitor.isRunning()).toBe(true);
      await jest.advanceTimersByTimeAsync(3000);
      expect(reader.readAll).toHaveBeenCalledTimes(3);

      monitor.stop();
      expect(monitor.isRunning()).toBe(false);
      await jest.advanceTimersByTimeAsync(3000);
      expect(reader.readAll).toHaveBeenCalledTimes(3);
    });

    test('disabled → start() schedules nothing', async () => {
      jest.useFakeTimers();
      const reader = makeReader({ default: { main: '1' } });
      const monitor = new CatalogFreshnessMonitor(makeTarget({ default: { main: '1' } }), reader, {
        enabled: false,
        intervalMs: 1000,
      });

      monitor.start();
      await jest.advanceTimersByTimeAsync(5000);

      expect(monitor.isRunning()).toBe(false);
      expect(reader.readAll).not.toHaveBeenCalled();
      expect(monitor.getStatus().enabled).toBe(false);
    });

    test('a tick arriving while a probe runs is skipped', async () => {
      const target = makeTarget({ default: { main: '1' } });
      let release: () => void = () => {};
      const reader = {
        readAll: jest.fn(
          () =>
            new Promise<CatalogProbeResult[]>((resolve) => {
              release = () =>
                resolve([
                  {
                    catalog: 'default',
                    schemas: { main: { marker: { version: '1', updatedAt: null } } },
                  },
                ]);
            }),
        ),
      };
      const monitor = new CatalogFreshnessMonitor(target, reader, settings);

      const first = monitor.tick();
      // Laisse la sonde démarrer (lecture en attente)
      await new Promise((resolve) => setImmediate(resolve));
      await monitor.tick();
      release();
      await first;

      expect(reader.readAll).toHaveBeenCalledTimes(1);
      expect(monitor.getStatus().skippedTicks).toBe(1);
    });

    test('an invalid interval falls back to 60 s', () => {
      const monitor = new CatalogFreshnessMonitor(makeTarget({}), makeReader({}), {
        enabled: true,
        intervalMs: Number.NaN,
      });
      expect(monitor.getStatus().intervalMs).toBe(60000);
    });
  });
});
