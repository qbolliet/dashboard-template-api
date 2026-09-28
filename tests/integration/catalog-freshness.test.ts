/**
 * Integration test: catalog updates reach every replica, without admin calls.
 *
 * Two "API instances" — two DatabaseManagers, each with its own DuckDB pool
 * and its own freshness monitor — serve one DuckLake catalog and share one
 * cache store (the shared Redis, simulated by a Map). A writer then updates the
 * data and stamps dataset_metadata.updated_at in one transaction, as
 * dt-ducklake-manager does. Acceptance criteria:
 *  - both instances detect the update on their first probe after the write
 *    (within one probe interval) and serve the new data version, with no call
 *    to /api/catalog/reload nor /api/cache/invalidate-all;
 *  - no entry of the old version is served afterwards: both instances build
 *    new-version keys, and the old entry is left in the store, unread, until
 *    its TTL.
 *
 * The catalog metadata lives in SQLite: a `.ducklake` (DuckDB file) catalog
 * cannot be written while the pools hold it attached (file lock, blocking on
 * Windows), whereas SQLite — like the Postgres catalogs used in production —
 * accepts a writer next to attached readers. The monitor's reader attaches the
 * catalog afresh at each probe, so the backend does not change its logic.
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';

// ─── Redis partagé simulé ─────────────────────────────────────────────────────

// Magasin commun aux deux instances, et journal des lectures
const store = new Map<string, string>();
const reads: string[] = [];
const fakeRedis = {
  get: jest.fn(async (key: string) => {
    reads.push(key);
    return store.get(key) ?? null;
  }),
  set: jest.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
};

jest.unstable_mockModule('../../src/cache/index.js', () => ({ redis: fakeRedis }));

// ─── Interfaces ───────────────────────────────────────────────────────────────

type DatabaseManagerType = import('../../src/db/database-manager.js').DatabaseManager;
type MonitorType = import('../../src/db/catalog-freshness.js').CatalogFreshnessMonitor;

/** Une « instance d'API » : gestionnaire, pool et sondeur propres. */
interface ApiInstance {
  manager: DatabaseManagerType;
  monitor: MonitorType;
  /** Heures de début des sondes (ms). */
  probeStarts: number[];
  /** Heure de début de la sonde ayant vu le changement. */
  detectedProbeStart: number | null;
}

// ─── Réglages ─────────────────────────────────────────────────────────────────

// Intervalle de sonde du test (ms)
const INTERVAL_MS = 1500;
// Tolérance de planification du timer (ms)
const TIMER_SLACK_MS = 250;

const CATALOG = 'lake';
const V1 = '2026-09-01 02:00:00.000001';
const V2 = '2026-09-02 02:00:00.000002';

let dir: string;
let catalogUrl: string;
let DatabaseManager: typeof import('../../src/db/database-manager.js').DatabaseManager;
let CatalogFreshnessMonitor: typeof import('../../src/db/catalog-freshness.js').CatalogFreshnessMonitor;
let DuckLakeProbeReader: typeof import('../../src/db/catalog-freshness.js').DuckLakeProbeReader;
let buildCacheKey: typeof import('../../src/cache/cache-keys.js').buildCacheKey;
let withCache: typeof import('../../src/utils/cache.js').withCache;
const instances: ApiInstance[] = [];

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/**
 * Runs statements on the catalog as the external writer, then detaches.
 *
 * @param statements - SQL statements, `lake` being the catalog alias.
 */
async function write(statements: string[]): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    await conn.run('LOAD ducklake');
    await conn.run(`ATTACH '${catalogUrl}' AS lake (DATA_PATH '${dir}/data/')`);
    for (const statement of statements) {
      await conn.run(statement);
    }
    await conn.run('DETACH lake');
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

/**
 * Reads the fact value through the shared cache, as a loader would.
 *
 * @param api - Instance serving the read.
 * @returns The value and the cache key used.
 */
async function cachedRead(api: ApiInstance): Promise<{ value: number; key: string }> {
  const key = buildCacheKey(
    { prefix: 'facts', catalog: CATALOG, schema: 'main', hash: 'value-query' },
    (c, s) => api.manager.getDataVersion(c, s),
  );
  const value = await withCache(key, async () => {
    const pool = api.manager.getPool(CATALOG);
    const conn = await pool.acquire();
    try {
      const rows = await conn.all('SELECT value FROM "lake"."main"."fact_table"');
      return Number(rows[0]['value']);
    } finally {
      pool.release(conn);
    }
  });
  return { value, key };
}

/**
 * Waits until a condition holds, polling every 25 ms.
 *
 * @param condition - Condition to wait for.
 * @param timeoutMs - Maximum wait.
 */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Epoch in microseconds of a naive UTC timestamp literal, as DuckDB's epoch_us.
 *
 * @param literal - `YYYY-MM-DD HH:MM:SS.ffffff`.
 * @returns The version string expected in cache keys.
 */
function epochUs(literal: string): string {
  const [seconds, fraction] = literal.split('.');
  const ms = Date.parse(`${seconds.replace(' ', 'T')}Z`);
  return (BigInt(ms) * 1000n + BigInt(fraction.padEnd(6, '0'))).toString();
}

// ─── Préparation ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  ({ DatabaseManager } = await import('../../src/db/database-manager.js'));
  ({ CatalogFreshnessMonitor, DuckLakeProbeReader } =
    await import('../../src/db/catalog-freshness.js'));
  ({ buildCacheKey } = await import('../../src/cache/cache-keys.js'));
  ({ withCache } = await import('../../src/utils/cache.js'));

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-freshness-')).split(path.sep).join('/');
  catalogUrl = `ducklake:sqlite:${dir}/catalog.sqlite`;

  // Extension sqlite installée une fois (chargée ensuite automatiquement)
  const setup = await DuckDBInstance.create(':memory:');
  const setupConn = await setup.connect();
  await setupConn.run('INSTALL sqlite; LOAD sqlite;');
  setupConn.closeSync();
  setup.closeSync();

  // Catalogue initial : version V1, valeur 1
  await write([
    'CREATE TABLE lake.main.fact_table (value INTEGER)',
    'INSERT INTO lake.main.fact_table VALUES (1)',
    'CREATE TABLE lake.main.dataset_metadata (updated_at TIMESTAMP, schema_version INTEGER)',
    `INSERT INTO lake.main.dataset_metadata VALUES (TIMESTAMP '${V1}', 1)`,
  ]);

  // Deux instances d'API indépendantes sur le même catalogue
  for (let i = 0; i < 2; i += 1) {
    const manager = new DatabaseManager({
      catalogs: [
        {
          alias: CATALOG,
          type: 'file',
          path: `sqlite:${dir}/catalog.sqlite`,
          dataPath: `${dir}/data/`,
          readOnly: true,
        },
      ],
      schemas: { [CATALOG]: ['main'] },
    });
    await manager.initSchemas();

    const api: ApiInstance = {
      manager,
      monitor: undefined as unknown as MonitorType,
      probeStarts: [],
      detectedProbeStart: null,
    };
    // Lecteur réel, instrumenté : heure de début de chaque sonde
    const reader = new DuckLakeProbeReader();
    api.monitor = new CatalogFreshnessMonitor(
      manager,
      {
        readAll: async (targets) => {
          const startedAt = Date.now();
          api.probeStarts.push(startedAt);
          const results = await reader.readAll(targets);
          const seen = results[0]?.schemas['main']?.marker?.version;
          if (api.detectedProbeStart === null && seen === epochUs(V2)) {
            api.detectedProbeStart = startedAt;
          }
          return results;
        },
      },
      { enabled: true, intervalMs: INTERVAL_MS },
    );
    instances.push(api);
  }
}, 60000);

afterAll(async () => {
  for (const api of instances) {
    api.monitor.stop();
    await api.manager.close();
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Fichiers encore verrouillés (Windows) : le dossier temporaire est laissé
  }
});

// ─── Test ─────────────────────────────────────────────────────────────────────

describe('catalog freshness across two API instances', () => {
  test('an update is seen by both instances within one probe interval, old keys are never served', async () => {
    const [a, b] = instances;

    // 1. État initial : les deux instances servent V1 et partagent la même entrée
    expect(a.manager.getDataVersion(CATALOG, 'main')).toBe(epochUs(V1));
    expect(b.manager.getDataVersion(CATALOG, 'main')).toBe(epochUs(V1));
    const firstA = await cachedRead(a);
    const firstB = await cachedRead(b);
    expect(firstA).toEqual({ value: 1, key: `facts:lake:main@${epochUs(V1)}:value-query` });
    expect(firstB.key).toBe(firstA.key);
    const oldKey = firstA.key;

    // 2. Sondeurs démarrés, puis écriture (donnée + updated_at, une transaction)
    a.monitor.start();
    b.monitor.start();
    const writtenAt = Date.now();
    await write([
      'BEGIN',
      'UPDATE lake.main.fact_table SET value = 2',
      `UPDATE lake.main.dataset_metadata SET updated_at = TIMESTAMP '${V2}'`,
      'COMMIT',
    ]);

    // 3. Les deux instances basculent seules, sans appel d'administration
    await waitFor(
      () =>
        a.manager.getDataVersion(CATALOG, 'main') === epochUs(V2) &&
        b.manager.getDataVersion(CATALOG, 'main') === epochUs(V2),
      3 * INTERVAL_MS + 5000,
    );

    for (const api of [a, b]) {
      // Changement vu par la première sonde lancée après l'écriture
      expect(api.detectedProbeStart).not.toBeNull();
      expect(api.detectedProbeStart! - writtenAt).toBeLessThanOrEqual(INTERVAL_MS + TIMER_SLACK_MS);
      const probesAfterWrite = api.probeStarts.filter((t) => t >= writtenAt);
      expect(probesAfterWrite[0]).toBe(api.detectedProbeStart);

      const status = api.monitor.getStatus();
      expect(status.lastReloadAt).toEqual(expect.any(String));
      expect(status.catalogs[CATALOG].schemas['main']).toEqual(
        expect.objectContaining({ servedVersion: epochUs(V2), probedVersion: epochUs(V2) }),
      );
    }

    // 4. Aucune entrée de l'ancienne version n'est plus servie
    reads.length = 0;
    const afterA = await cachedRead(a);
    const afterB = await cachedRead(b);
    const newKey = `facts:lake:main@${epochUs(V2)}:value-query`;
    expect(afterA).toEqual({ value: 2, key: newKey });
    expect(afterB).toEqual({ value: 2, key: newKey });
    expect(reads).not.toContain(oldKey);
    // L'ancienne entrée reste dans Redis, inaccessible, jusqu'à son TTL
    expect(store.get(oldKey)).toBe('1');
  }, 30000);
});
