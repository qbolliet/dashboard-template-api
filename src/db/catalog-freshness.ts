// Détection des mises à jour de catalogue sur chaque réplica (sondage périodique)
import {
  buildCatalogSql,
  createConfiguredInstance,
  listCatalogSchemas,
  type CatalogEntry,
} from './pool.js';
import {
  databaseManager,
  DATA_VERSION_SELECT,
  NO_DATA_VERSION,
  toDataVersion,
  type DataVersion,
} from './database-manager.js';
import { config } from '../utils/config-loader.js';
import { qualifiedTable, quoteIdent } from '../utils/identifiers.js';
import { createContextLogger, logger } from '../utils/logger.js';

/**
 * Catalog freshness monitor.
 *
 * Every replica attaches its DuckLake catalogs once and keeps serving that
 * state; Redis is shared by all of them. To pick up a nightly update on every
 * pod without any call from the updater, each pod periodically reads the data
 * marker of every schema — `dataset_metadata.updated_at`, stamped inside the
 * transaction of every write — on a throw-away DuckDB instance that attaches
 * the catalogs afresh (so it sees the latest committed state whatever the
 * backend). When a marker differs from the version the pod serves, the pod
 * rebuilds its instance (`DatabaseManager.reloadCatalogs`), which re-reads the
 * versions on the live instance; those versions are part of every Redis key,
 * so entries computed on older data are no longer reachable.
 *
 * The same probe lists the schemas of each catalog and reconciles them with
 * the configuration exactly as the reload does (`reconcileSchemas`): a schema
 * added or removed by the updater changes that list and triggers the reload
 * too, so it appears in (or disappears from) `getCatalogs` without any call.
 */

const freshnessLogger = createContextLogger({
  component: 'database',
  module: 'catalog-freshness',
});

// Intervalle par défaut entre deux sondes (ms)
const DEFAULT_INTERVAL_MS = 60000;

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Marker read for one schema: the version, or the read error. */
interface SchemaProbe {
  /** Version read, or null when the read failed. */
  marker: DataVersion | null;
  error?: string;
}

/** Markers read for one catalog. */
interface CatalogProbeResult {
  catalog: string;
  /**
   * Schema → marker, for the served schemas still present in the catalog;
   * empty when the catalog itself could not be read.
   */
  schemas: Record<string, SchemaProbe>;
  /** Schemas listed in the catalog, or null when the list could not be read. */
  discovered: string[] | null;
  /** Failure to list the schemas (the markers are then read for every served schema). */
  discoveryError?: string;
  /** Catalog-level failure (attach, instance creation). */
  error?: string;
}

/** A catalog to probe and the served schemas whose markers are read. */
interface ProbeTarget {
  catalog: CatalogEntry;
  schemas: string[];
}

/** Reads the latest committed markers of a set of catalogs. */
interface MarkerReader {
  readAll(targets: ProbeTarget[]): Promise<CatalogProbeResult[]>;
}

/** What the monitor needs from the database layer (implemented by DatabaseManager). */
interface FreshnessTarget {
  getCatalogEntries(): CatalogEntry[];
  getSchemas(catalogId: string): string[];
  reconcileSchemas(catalogId: string, discovered: string[]): string[];
  getDataVersion(catalogId: string, schema: string): string;
  getDataVersions(): Record<string, Record<string, DataVersion>>;
  reloadCatalogs(): Promise<void>;
}

/** Monitor settings. */
interface FreshnessSettings {
  enabled: boolean;
  intervalMs: number;
}

/** Freshness state of one schema, exposed in /metrics. */
interface SchemaFreshnessStatus {
  /** Version the pod serves (and puts in its cache keys). */
  servedVersion: string;
  servedUpdatedAt: string | null;
  /** Version read by the last successful probe of this schema. */
  probedVersion: string | null;
  probedUpdatedAt: string | null;
  /** Date of the last probe of this schema (successful or not). */
  lastProbeAt: string | null;
  lastError: string | null;
}

/** Freshness state of one catalog, exposed in /metrics. */
interface CatalogFreshnessStatus {
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastError: string | null;
  /** Last time a probe saw a marker or the schema list differ from what is served. */
  lastChangeAt: string | null;
  /** Schemas listed by the last probe (null before the first one or when unreadable). */
  discoveredSchemas: string[] | null;
  schemas: Record<string, SchemaFreshnessStatus>;
}

/** Full freshness state, exposed in /metrics. */
interface FreshnessStatus {
  enabled: boolean;
  intervalMs: number;
  /** Last successful reload triggered by the monitor or the admin route. */
  lastReloadAt: string | null;
  lastReloadError: string | null;
  /** Ticks skipped because the previous probe was still running. */
  skippedTicks: number;
  catalogs: Record<string, CatalogFreshnessStatus>;
}

/** What a reload is expected to serve, checked once it is done. */
interface ReloadExpectations {
  /** Probed markers that differed from the served version. */
  versions: { catalog: string; schema: string; version: string }[];
  /** Reconciled schema lists that differed from the served list. */
  schemaLists: { catalog: string; schemas: string[] }[];
}

/** Result of one probe. */
interface ProbeOutcome {
  /** Catalogs where a marker or the schema list differed from what is served. */
  changed: string[];
  /** Whether the instance was rebuilt. */
  reloaded: boolean;
  /** Versions served after the probe (and the reload, if any). */
  versions: Record<string, Record<string, DataVersion>>;
}

// ─── Lecteur par défaut : instance DuckDB éphémère ─────────────────────────────

/**
 * Builds the result of a catalog that could not be read at all.
 *
 * @param target - Catalog probed.
 * @param error - Failure message.
 * @returns A result without markers nor schema list.
 */
function catalogFailure(target: ProbeTarget, error: string): CatalogProbeResult {
  return { catalog: target.catalog.alias, schemas: {}, discovered: null, error };
}

/**
 * Reads markers on a throw-away DuckDB instance created for each probe.
 *
 * A fresh instance and a fresh ATTACH are what guarantees seeing the latest
 * committed snapshot: an ATTACH held open does not see later writes to a
 * `.ducklake` file (and on Windows blocks the writer), and a reused instance
 * could serve cached blocks of a remote file. The catalogs are attached
 * READ_ONLY under `__probe_<alias>`; a failure on one catalog does not prevent
 * reading the others. Listing the schemas only reads the DuckLake catalog
 * loaded by the ATTACH, never a data file.
 */
class DuckLakeProbeReader implements MarkerReader {
  /**
   * @param targets - Catalogs to probe, with the schemas to read.
   * @returns One result per catalog, in the order of the targets.
   */
  async readAll(targets: ProbeTarget[]): Promise<CatalogProbeResult[]> {
    if (targets.length === 0) return [];

    // Instance neuve à chaque sonde (extensions et secrets comme le pool)
    let instance: Awaited<ReturnType<typeof createConfiguredInstance>>;
    try {
      instance = await createConfiguredInstance(targets.map((t) => t.catalog));
    } catch (error) {
      const message = (error as Error).message;
      return targets.map((t) => catalogFailure(t, message));
    }

    let conn: Awaited<ReturnType<typeof instance.connect>>;
    try {
      conn = await instance.connect();
    } catch (error) {
      instance.closeSync();
      const message = (error as Error).message;
      return targets.map((t) => catalogFailure(t, message));
    }
    try {
      // Sonde légère : un seul thread suffit à lire quelques lignes
      await conn.run('SET threads = 1');

      const results: CatalogProbeResult[] = [];
      for (const target of targets) {
        results.push(await this.readCatalog(conn, target));
      }
      return results;
    } finally {
      conn.closeSync();
      instance.closeSync();
    }
  }

  /**
   * Attaches one catalog, lists its schemas, reads the marker of each served
   * schema still present, then detaches it.
   *
   * A served schema absent from the list is not read (it was removed: the
   * monitor sees the removal in the list, not as an unreadable marker). When
   * a marker read fails, the list is read again, since each statement sees the
   * latest committed state and the schema may have been dropped in between.
   * When the list cannot be read, every served schema is read as before.
   *
   * @param conn - Connection of the throw-away instance.
   * @param target - Catalog and served schemas.
   * @returns The schema list and the markers read, or the catalog-level error.
   */
  private async readCatalog(
    conn: Awaited<ReturnType<Awaited<ReturnType<typeof createConfiguredInstance>>['connect']>>,
    target: ProbeTarget,
  ): Promise<CatalogProbeResult> {
    const alias = `__probe_${target.catalog.alias}`;
    try {
      // ATTACH neuf en lecture seule sous un alias dédié
      for (const statement of buildCatalogSql({ ...target.catalog, alias, readOnly: true })) {
        await conn.run(statement);
      }
    } catch (error) {
      return catalogFailure(target, (error as Error).message);
    }

    try {
      // Liste des schémas du catalogue sondé (mêmes exclusions que la découverte)
      let discovered: string[] | null = null;
      let discoveryError: string | undefined;
      try {
        discovered = (await listCatalogSchemas(conn, [alias]))[alias] ?? [];
      } catch (error) {
        discoveryError = (error as Error).message;
      }

      const schemas: Record<string, SchemaProbe> = {};
      const listed = discovered;
      const toRead = listed ? target.schemas.filter((s) => listed.includes(s)) : target.schemas;
      for (const schema of toRead) {
        try {
          const result = await conn.run(
            `SELECT ${DATA_VERSION_SELECT} FROM ${qualifiedTable(alias, schema, 'dataset_metadata')} LIMIT 1`,
          );
          const rows = await result.getRowObjectsJson();
          schemas[schema] = { marker: toDataVersion(rows[0]) };
        } catch (error) {
          schemas[schema] = { marker: null, error: (error as Error).message };
        }
      }

      // Chaque requête lit le dernier état validé : un schéma supprimé entre la
      // liste et la lecture de son marqueur fait échouer celle-ci. Liste relue
      // une fois ; un schéma disparu est un retrait, pas un marqueur illisible.
      if (discovered && Object.values(schemas).some((probe) => probe.marker === null)) {
        try {
          const fresh = (await listCatalogSchemas(conn, [alias]))[alias] ?? [];
          for (const schema of Object.keys(schemas)) {
            if (!fresh.includes(schema)) delete schemas[schema];
          }
          discovered = fresh;
        } catch {
          // Relecture impossible : la première liste et l'échec du marqueur restent
        }
      }

      return {
        catalog: target.catalog.alias,
        schemas,
        discovered,
        ...(discoveryError !== undefined && { discoveryError }),
      };
    } finally {
      try {
        await conn.run(`DETACH ${quoteIdent(alias)}`);
      } catch {
        // Instance fermée juste après : un DETACH manqué est sans effet
      }
    }
  }
}

// ─── Moniteur ─────────────────────────────────────────────────────────────────

/**
 * Probes the catalogs periodically and reloads the pod when data or schemas changed.
 *
 * Probes never overlap: a tick arriving while a probe runs is skipped, and an
 * explicit {@link probeNow} waits for the running probe before its own. A read
 * error never triggers a reload (the pod keeps serving what it has, and says
 * so in a warn log); a failed reload leaves the served versions unchanged and
 * is retried at the next tick, since the markers (or schema lists) still differ.
 */
class CatalogFreshnessMonitor {
  private readonly target: FreshnessTarget;
  private readonly reader: MarkerReader;
  private readonly settings: FreshnessSettings;
  private timer: ReturnType<typeof setInterval> | null;
  // File des sondes : chaque sonde démarre après la précédente
  private queue: Promise<unknown>;
  private running: boolean;
  private skippedTicks: number;
  private lastReloadAt: string | null;
  private lastReloadError: string | null;
  private readonly catalogStatus: Map<string, CatalogFreshnessStatus>;

  /**
   * @param target - Database layer to probe and reload.
   * @param reader - Reader of the latest committed markers.
   * @param settings - Whether the periodic probe runs, and its interval.
   */
  constructor(target: FreshnessTarget, reader: MarkerReader, settings: FreshnessSettings) {
    this.target = target;
    this.reader = reader;
    // Intervalle invalide : repli sur la valeur par défaut
    const intervalMs =
      Number.isFinite(settings.intervalMs) && settings.intervalMs > 0
        ? settings.intervalMs
        : DEFAULT_INTERVAL_MS;
    this.settings = { enabled: settings.enabled, intervalMs };
    this.timer = null;
    this.queue = Promise.resolve();
    this.running = false;
    this.skippedTicks = 0;
    this.lastReloadAt = null;
    this.lastReloadError = null;
    this.catalogStatus = new Map();
  }

  /**
   * Starts the periodic probe. No-op when disabled or already started.
   * The timer is unref'd: it never keeps the process alive on its own.
   */
  start(): void {
    if (!this.settings.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.settings.intervalMs);
    this.timer.unref?.();
    freshnessLogger.database('Catalog freshness probe started', {
      intervalMs: this.settings.intervalMs,
    });
  }

  /** Stops the periodic probe (graceful shutdown). A running probe completes. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the periodic probe is currently scheduled. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * One periodic tick: probes unless the previous probe is still running.
   * Never throws (errors are logged by the probe itself).
   */
  async tick(): Promise<void> {
    if (this.running) {
      this.skippedTicks += 1;
      return;
    }
    try {
      await this.probeNow();
    } catch {
      // Déjà journalisé par la sonde
    }
  }

  /**
   * Probes every catalog now and reloads the pod if a marker or a schema list changed.
   *
   * @param options - `forceReload` rebuilds the instance even when no marker
   *   changed (admin reload route, kept for compatibility).
   * @returns The catalogs that changed, whether a reload ran, and the served versions.
   * @throws {Error} Only with `forceReload`, when the reload itself fails.
   */
  probeNow(options: { forceReload?: boolean } = {}): Promise<ProbeOutcome> {
    const run = this.queue.then(() => this.runProbe(options.forceReload ?? false));
    // La file survit à l'échec d'une sonde
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Returns the freshness state of every catalog/schema, for /metrics.
   *
   * @returns Settings, last reload, and per-schema served/probed markers.
   */
  getStatus(): FreshnessStatus {
    const served = this.target.getDataVersions();
    const catalogs: Record<string, CatalogFreshnessStatus> = {};

    for (const [catalogId, schemaVersions] of Object.entries(served)) {
      const known = this.catalogStatus.get(catalogId);
      const schemas: Record<string, SchemaFreshnessStatus> = {};
      for (const [schema, version] of Object.entries(schemaVersions)) {
        const probed = known?.schemas[schema];
        schemas[schema] = {
          servedVersion: version.version,
          servedUpdatedAt: version.updatedAt,
          probedVersion: probed?.probedVersion ?? null,
          probedUpdatedAt: probed?.probedUpdatedAt ?? null,
          lastProbeAt: probed?.lastProbeAt ?? null,
          lastError: probed?.lastError ?? null,
        };
      }
      catalogs[catalogId] = {
        lastProbeAt: known?.lastProbeAt ?? null,
        lastProbeOk: known?.lastProbeOk ?? null,
        lastError: known?.lastError ?? null,
        lastChangeAt: known?.lastChangeAt ?? null,
        discoveredSchemas: known?.discoveredSchemas ?? null,
        schemas,
      };
    }

    return {
      enabled: this.settings.enabled,
      intervalMs: this.settings.intervalMs,
      lastReloadAt: this.lastReloadAt,
      lastReloadError: this.lastReloadError,
      skippedTicks: this.skippedTicks,
      catalogs,
    };
  }

  /**
   * Reads the schema lists and markers, compares them with what is served,
   * reloads if needed.
   *
   * @param forceReload - Reload even when nothing changed.
   * @returns The probe outcome.
   * @throws {Error} When `forceReload` is set and the reload fails.
   */
  private async runProbe(forceReload: boolean): Promise<ProbeOutcome> {
    this.running = true;
    try {
      const targets = this.target.getCatalogEntries().map((catalog) => ({
        catalog,
        schemas: this.target.getSchemas(catalog.alias),
      }));

      // Lecture des marqueurs ; un échec global vaut échec de chaque catalogue
      let results: CatalogProbeResult[];
      try {
        results = await this.reader.readAll(targets);
      } catch (error) {
        const message = (error as Error).message;
        results = targets.map((t) => catalogFailure(t, message));
      }

      const probedAt = new Date().toISOString();
      const changed: string[] = [];
      // Marqueurs et listes sondés ayant motivé le rechargement (contrôle après reload)
      const expected: ReloadExpectations = { versions: [], schemaLists: [] };

      for (const result of results) {
        if (this.recordResult(result, probedAt, expected)) {
          changed.push(result.catalog);
        }
      }

      if (changed.length === 0 && !forceReload) {
        return { changed, reloaded: false, versions: this.target.getDataVersions() };
      }

      if (changed.length > 0) {
        logger.info('Catalog update detected, reloading catalogs', { catalogs: changed });
      }

      // Rechargement : nouvelle instance, drainage, relecture des versions servies
      try {
        await this.target.reloadCatalogs();
        this.lastReloadAt = new Date().toISOString();
        this.lastReloadError = null;
      } catch (error) {
        this.lastReloadError = (error as Error).message;
        freshnessLogger.warn('Catalog reload after update failed; retrying at next probe', {
          catalogs: changed,
          error: (error as Error).message,
        });
        if (forceReload) throw error;
        return { changed, reloaded: false, versions: this.target.getDataVersions() };
      }

      // Version servie différente de la version sondée : l'instance vivante ne
      // voit pas encore l'écriture (ou une écriture plus récente) — signalé
      for (const { catalog, schema, version } of expected.versions) {
        const servedNow = this.target.getDataVersion(catalog, schema);
        if (servedNow !== version) {
          freshnessLogger.warn('Reloaded catalog serves another version than the one probed', {
            catalog,
            schema,
            probed: version,
            served: servedNow,
          });
        }
      }
      // Même contrôle pour la liste des schémas
      for (const { catalog, schemas } of expected.schemaLists) {
        const servedNow = this.target.getSchemas(catalog);
        if (!sameSchemas(servedNow, schemas)) {
          freshnessLogger.warn('Reloaded catalog serves another schema list than the one probed', {
            catalog,
            probed: schemas,
            served: servedNow,
          });
        }
      }

      return { changed, reloaded: true, versions: this.target.getDataVersions() };
    } finally {
      this.running = false;
    }
  }

  /**
   * Records the probe result of one catalog and tells whether it changed.
   *
   * The schema list read is reconciled with the configuration as a reload
   * would (`reconcileSchemas`) and compared with the served list, order
   * ignored: an added or removed schema is a change, while a fallback (`main`
   * for an empty catalog, the configured list when none is discovered) is
   * stable. A list that cannot be read never counts as changed and is warned
   * about. A schema whose marker cannot be read never counts as changed
   * either; the failure is warned about, except when the schema is already
   * served without version (a schema without dataset_metadata, rejected by the
   * version guard anyway).
   *
   * @param result - Schema list and markers read for the catalog.
   * @param probedAt - ISO date of the probe.
   * @param expected - Accumulator of the changes, checked after reload.
   * @returns True when the schema list or a readable marker differs from what is served.
   */
  private recordResult(
    result: CatalogProbeResult,
    probedAt: string,
    expected: ReloadExpectations,
  ): boolean {
    const status: CatalogFreshnessStatus = this.catalogStatus.get(result.catalog) ?? {
      lastProbeAt: null,
      lastProbeOk: null,
      lastError: null,
      lastChangeAt: null,
      discoveredSchemas: null,
      schemas: {},
    };
    this.catalogStatus.set(result.catalog, status);
    status.lastProbeAt = probedAt;
    status.discoveredSchemas = result.discovered ? [...result.discovered] : null;

    // Échec au niveau du catalogue : aucune bascule
    if (result.error) {
      status.lastProbeOk = false;
      status.lastError = result.error;
      freshnessLogger.warn('Catalog freshness probe failed; keeping the served version', {
        catalog: result.catalog,
        error: result.error,
      });
      return false;
    }

    // Initialisation du statut de changement et d'erreur
    let changed = false;
    let failure: string | null = null;

    // Schéma découvert
    if (result.discovered) {
      // Liste réconciliée comme au rechargement, comparée à la liste servie
      const served = this.target.getSchemas(result.catalog);
      const reconciled = this.target.reconcileSchemas(result.catalog, result.discovered);
      const added = reconciled.filter((s) => !served.includes(s));
      const removed = served.filter((s) => !reconciled.includes(s));
      if (added.length > 0 || removed.length > 0) {
        changed = true;
        expected.schemaLists.push({ catalog: result.catalog, schemas: reconciled });
        logger.info('Catalog schema list changed', { catalog: result.catalog, added, removed });
      }
    } else {
      // Liste illisible : aucune bascule sur la liste, marqueurs lus quand même
      failure = result.discoveryError ?? 'unreadable schema list';
      freshnessLogger.warn('Schema list unreadable; keeping the served schemas', {
        catalog: result.catalog,
        error: failure,
      });
    }

    for (const [schema, probe] of Object.entries(result.schemas)) {
      const served = this.target.getDataVersion(result.catalog, schema);
      const schemaStatus = status.schemas[schema] ?? {
        servedVersion: served,
        servedUpdatedAt: null,
        probedVersion: null,
        probedUpdatedAt: null,
        lastProbeAt: null,
        lastError: null,
      };
      status.schemas[schema] = schemaStatus;
      schemaStatus.lastProbeAt = probedAt;

      // Marqueur illisible : aucune bascule pour ce schéma
      if (!probe.marker) {
        schemaStatus.lastError = probe.error ?? 'unreadable marker';
        if (served !== NO_DATA_VERSION) {
          failure = schemaStatus.lastError;
          freshnessLogger.warn('Data marker unreadable; keeping the served version', {
            catalog: result.catalog,
            schema,
            error: schemaStatus.lastError,
          });
        }
        continue;
      }

      schemaStatus.lastError = null;
      schemaStatus.probedVersion = probe.marker.version;
      schemaStatus.probedUpdatedAt = probe.marker.updatedAt;

      if (probe.marker.version !== served) {
        changed = true;
        expected.versions.push({ catalog: result.catalog, schema, version: probe.marker.version });
      }
    }

    status.lastProbeOk = failure === null;
    status.lastError = failure;
    if (changed) status.lastChangeAt = probedAt;
    return changed;
  }
}

/**
 * Tells whether two schema lists hold the same schemas, order ignored.
 *
 * @param a - First list.
 * @param b - Second list.
 * @returns True when every schema of one list is in the other.
 */
function sameSchemas(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}

// ─── Singleton applicatif ─────────────────────────────────────────────────────

/** Monitor of the application's catalogs, started by the server. */
const catalogFreshnessMonitor = new CatalogFreshnessMonitor(
  databaseManager,
  new DuckLakeProbeReader(),
  {
    enabled: config.CATALOG_FRESHNESS?.ENABLED ?? true,
    intervalMs: Number(config.CATALOG_FRESHNESS?.INTERVAL_MS ?? DEFAULT_INTERVAL_MS),
  },
);

export { CatalogFreshnessMonitor, DuckLakeProbeReader, catalogFreshnessMonitor };
export type {
  CatalogFreshnessStatus,
  CatalogProbeResult,
  FreshnessSettings,
  FreshnessStatus,
  FreshnessTarget,
  MarkerReader,
  ProbeOutcome,
  ProbeTarget,
  SchemaFreshnessStatus,
  SchemaProbe,
};
