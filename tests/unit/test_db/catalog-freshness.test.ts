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
  discovered: string[] | null;
  discoveryError?: string;
  error?: string;
}

/** Cible factice : état servi modifiable et reload instrumenté. */
interface FakeTarget {
  served: Record<string, Record<string, string>>;
  getCatalogEntries: jest.Mock;
  getSchemas: jest.Mock;
  reconcileSchemas: jest.Mock;
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
        discoveredSchemas: string[] | null;
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
  listCatalogSchemas: jest.fn(),
}));

let CatalogFreshnessMonitor: FreshnessModule['CatalogFreshnessMonitor'];
let reconcileSchemaList: typeof import('../../../src/db/schema-reconciliation.js').reconcileSchemaList;

beforeAll(async () => {
  ({ CatalogFreshnessMonitor } =
    (await import('../../../src/db/catalog-freshness.js')) as unknown as FreshnessModule);
  ({ reconcileSchemaList } = await import('../../../src/db/schema-reconciliation.js'));
});

// ─── Fabriques ────────────────────────────────────────────────────────────────

/**
 * Builds a fake database layer serving the given versions.
 *
 * The schema lists are reconciled with the real pure function, under the
 * given policy (discovery by default, as without `SCHEMAS`).
 *
 * Args:
 *     served: catalog → schema → served version.
 *     onReload: new served versions after a reload (default: unchanged).
 *     policies: catalog → configured schema policy (default: no explicit list).
 */
const makeTarget = (
  served: Record<string, Record<string, string>>,
  onReload?: () => Record<string, Record<string, string>>,
  policies: Record<string, { configured: string[]; explicit: boolean }> = {},
): FakeTarget => {
  const target: FakeTarget = {
    served,
    getCatalogEntries: jest.fn(() =>
      Object.keys(target.served).map((alias) => ({ alias, type: 'file', readOnly: true })),
    ),
    getSchemas: jest.fn((catalog: string) => Object.keys(target.served[catalog] ?? {})),
    reconcileSchemas: jest.fn(
      (catalog: string, discovered: string[]) =>
        reconcileSchemaList(
          discovered,
          policies[catalog] ?? { configured: ['main'], explicit: false },
        ).schemas,
    ),
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
 * The schema list of a catalog is the list of its markers, unless `discovered`
 * gives it (an Error meaning the list could not be read).
 *
 * Args:
 *     markers: catalog → schema → version (null = unreadable), or an Error for the catalog.
 *     discovered: catalog → schema list read, or an Error.
 */
const makeReader = (
  markers: Record<string, Record<string, string | null> | Error>,
  discovered: Record<string, string[] | Error> = {},
): { readAll: jest.Mock } => ({
  readAll: jest.fn(
    async (): Promise<CatalogProbeResult[]> =>
      Object.entries(markers).map(([catalog, value]) => {
        if (value instanceof Error) {
          return { catalog, schemas: {}, discovered: null, error: value.message };
        }
        const listed = discovered[catalog] ?? Object.keys(value);
        return {
          catalog,
          ...(listed instanceof Error
            ? { discovered: null, discoveryError: listed.message }
            : { discovered: listed }),
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
              discovered: ['main'],
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

  describe('schema list', () => {
    test('added schema → one reload, then it is served', async () => {
      const target = makeTarget({ default: { main: '1' } }, () => ({
        default: { main: '1', trade: '5' },
      }));
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '1' } }, { default: ['main', 'trade'] }),
        settings,
      );

      const outcome = await monitor.probeNow();

      expect(target.reloadCatalogs).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual(expect.objectContaining({ changed: ['default'], reloaded: true }));
      expect(mockLogger.info).toHaveBeenCalledWith('Catalog schema list changed', {
        catalog: 'default',
        added: ['trade'],
        removed: [],
      });
      expect(mockContextLogger.warn).not.toHaveBeenCalled();
      const status = monitor.getStatus().catalogs['default'];
      expect(status.discoveredSchemas).toEqual(['main', 'trade']);
      expect(status.lastChangeAt).toEqual(expect.any(String));
      expect(Object.keys(status.schemas)).toEqual(['main', 'trade']);
    });

    test('removed schema → one reload, no unreadable-marker warn, then stable', async () => {
      const target = makeTarget({ default: { main: '1', old: '3' } }, () => ({
        default: { main: '1' },
      }));
      // Le lecteur ne lit pas le marqueur d'un schéma servi absent de la liste
      const reader = makeReader({ default: { main: '1' } }, { default: ['main'] });
      const monitor = new CatalogFreshnessMonitor(target, reader, settings);

      const first = await monitor.probeNow();
      expect(first.reloaded).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('Catalog schema list changed', {
        catalog: 'default',
        added: [],
        removed: ['old'],
      });

      const second = await monitor.probeNow();
      expect(second.reloaded).toBe(false);
      expect(target.reloadCatalogs).toHaveBeenCalledTimes(1);
      expect(mockContextLogger.warn).not.toHaveBeenCalled();
      expect(monitor.getStatus().catalogs['default'].schemas).not.toHaveProperty('old');
    });

    test('catalog without discovered schema (fallback main) → ten probes, zero reload', async () => {
      const target = makeTarget({ default: { main: 'none' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: {} }, { default: [] }),
        settings,
      );

      for (let i = 0; i < 10; i += 1) {
        await monitor.probeNow();
      }

      expect(target.reloadCatalogs).not.toHaveBeenCalled();
      expect(mockContextLogger.warn).not.toHaveBeenCalled();
      expect(monitor.getStatus().catalogs['default'].discoveredSchemas).toEqual([]);
    });

    test('explicit list narrower than the discovery → ten probes, zero reload', async () => {
      const target = makeTarget({ default: { main: '1' } }, undefined, {
        default: { configured: ['main'], explicit: true },
      });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '1' } }, { default: ['trade', 'main', 'other'] }),
        settings,
      );

      for (let i = 0; i < 10; i += 1) {
        await monitor.probeNow();
      }

      expect(target.reloadCatalogs).not.toHaveBeenCalled();
      expect(mockContextLogger.warn).not.toHaveBeenCalled();
    });

    test('explicit list entirely missing (config kept) → no reload, no warn', async () => {
      const target = makeTarget({ default: { gone: '4' } }, undefined, {
        default: { configured: ['gone'], explicit: true },
      });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: {} }, { default: ['main'] }),
        settings,
      );

      for (let i = 0; i < 10; i += 1) {
        await monitor.probeNow();
      }

      expect(target.reloadCatalogs).not.toHaveBeenCalled();
      expect(mockContextLogger.warn).not.toHaveBeenCalled();
    });

    test('schema order differing from the served one is not a change', async () => {
      const target = makeTarget({ default: { main: '1', b: '2', a: '3' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '1', b: '2', a: '3' } }, { default: ['b', 'a', 'main'] }),
        settings,
      );

      const outcome = await monitor.probeNow();

      expect(outcome.reloaded).toBe(false);
    });

    test('unreadable schema list → no switch on the list, warn, markers still read', async () => {
      const target = makeTarget({ default: { main: '1' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '1' } }, { default: new Error('Catalog Error: timeout') }),
        settings,
      );

      const outcome = await monitor.probeNow();

      expect(outcome.reloaded).toBe(false);
      expect(target.reconcileSchemas).not.toHaveBeenCalled();
      expect(mockContextLogger.warn).toHaveBeenCalledWith(
        'Schema list unreadable; keeping the served schemas',
        { catalog: 'default', error: 'Catalog Error: timeout' },
      );
      const status = monitor.getStatus().catalogs['default'];
      expect(status.lastProbeOk).toBe(false);
      expect(status.lastError).toBe('Catalog Error: timeout');
      expect(status.discoveredSchemas).toBeNull();
      expect(status.schemas['main'].probedVersion).toBe('1');
    });

    test('unreadable schema list does not prevent a marker change from reloading', async () => {
      const target = makeTarget({ default: { main: '1' } }, () => ({ default: { main: '2' } }));
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '2' } }, { default: new Error('Catalog Error: timeout') }),
        settings,
      );

      const outcome = await monitor.probeNow();

      expect(outcome.reloaded).toBe(true);
      expect(target.served['default']['main']).toBe('2');
    });

    test('schema listed before its dataset_metadata: guarded, then served once written', async () => {
      // 1. Schéma découvert sans dataset_metadata : ajouté, servi sans version
      //    (refusé par la garde, donc absent de getCatalogs)
      const target = makeTarget({ default: { main: '1' } }, () => ({
        default: { main: '1', fresh: 'none' },
      }));
      // Lecteur délégué, remplacé à chaque étape
      let current = makeReader({ default: { main: '1' } }, { default: ['main', 'fresh'] });
      const reader = { readAll: jest.fn(async () => current.readAll()) };
      const monitor = new CatalogFreshnessMonitor(target, reader, settings);
      expect((await monitor.probeNow()).reloaded).toBe(true);

      // 2. Toujours sans dataset_metadata : ni rechargement ni warn
      current = makeReader({ default: { main: '1', fresh: null } });
      expect((await monitor.probeNow()).reloaded).toBe(false);
      expect(mockContextLogger.warn).not.toHaveBeenCalled();

      // 3. dataset_metadata écrite : la sonde suivante recharge
      current = makeReader({ default: { main: '1', fresh: '7' } });
      const third = await monitor.probeNow();
      expect(third.reloaded).toBe(true);
      expect(target.reloadCatalogs).toHaveBeenCalledTimes(2);
    });

    test('reload serving another schema list than the probed one is warned about', async () => {
      // L'instance vivante ne voit pas encore le nouveau schéma
      const target = makeTarget({ default: { main: '1' } });
      const monitor = new CatalogFreshnessMonitor(
        target,
        makeReader({ default: { main: '1' } }, { default: ['main', 'trade'] }),
        settings,
      );

      await monitor.probeNow();

      expect(mockContextLogger.warn).toHaveBeenCalledWith(
        'Reloaded catalog serves another schema list than the one probed',
        { catalog: 'default', probed: ['main', 'trade'], served: ['main'] },
      );
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
                    discovered: ['main'],
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

describe('reconcileSchemaList', () => {
  test('no explicit list → discovered schemas, main first then alphabetical', () => {
    expect(
      reconcileSchemaList(['trade', 'main', 'agri'], { configured: ['main'], explicit: false }),
    ).toEqual({ schemas: ['main', 'agri', 'trade'], missing: [], keptConfigured: false });
  });

  test('no explicit list and nothing discovered → fallback main', () => {
    expect(reconcileSchemaList([], { configured: ['main'], explicit: false })).toEqual({
      schemas: ['main'],
      missing: [],
      keptConfigured: false,
    });
  });

  test('explicit list → intersection in config order, missing ones reported', () => {
    expect(
      reconcileSchemaList(['main', 'agri', 'trade'], {
        configured: ['trade', 'gone', 'main'],
        explicit: true,
      }),
    ).toEqual({ schemas: ['trade', 'main'], missing: ['gone'], keptConfigured: false });
  });

  test('explicit list entirely missing → configuration kept', () => {
    expect(reconcileSchemaList(['main'], { configured: ['a', 'b'], explicit: true })).toEqual({
      schemas: ['a', 'b'],
      missing: ['a', 'b'],
      keptConfigured: true,
    });
  });

  test('is pure: inputs untouched, same result on every call', () => {
    const discovered = ['b', 'main', 'a'];
    const policy = { configured: ['main'], explicit: false };
    const first = reconcileSchemaList(discovered, policy);
    expect(reconcileSchemaList(discovered, policy)).toEqual(first);
    expect(discovered).toEqual(['b', 'main', 'a']);
    expect(policy.configured).toEqual(['main']);
  });
});
