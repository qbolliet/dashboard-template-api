// Importation des modules
import { createHash } from 'node:crypto';
import DataLoader from 'dataloader';
import { GraphQLError } from 'graphql';
import { databaseManager } from '../db/index.js';
import type { ConnectionWrapper as DuckDBConnection, DuckDBPool } from '../db/pool.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { withCache } from '../utils/cache.js';
import { buildCacheKey } from '../cache/cache-keys.js';
import { logger } from '../utils/logger.js';
import { config as globalConfig } from '../utils/config-loader.js';
import { ALL_COLUMNS_FIELD } from '../utils/default-sort.js';
import { qualifiedTable, quoteIdent } from '../utils/identifiers.js';
import { toLoaderError } from './loader-errors.js';
import { runInterruptible } from '../db/interrupt.js';

// ─── Interfaces de la connexion DuckDB ───────────────────────────────────────

/** Metadata of a D3 query result (columns, extents, pagination). */
interface D3Metadata {
  count: number;
  extents: Record<string, [number, number] | [string, string]>;
  total?: number;
  hasNextPage?: boolean;
  currentPage?: number;
  totalPages?: number;
  generatedAt?: string;
}

/** Enriched query result for D3 visualization. */
interface D3QueryResult {
  columns: string[];
  /** DuckDB types of the columns, same order as columns. */
  columnTypes?: string[];
  data: Record<string, unknown>[];
  metadata: D3Metadata;
}

// ─── Interfaces de configuration des loaders ─────────────────────────────────

/** Initialization configuration for a base loader. */
interface BaseLoaderConfig {
  batchSize?: number;
  cachePrefix?: string;
  cache?: boolean;
  cacheTimeout?: number;
  catalogId?: string | null;
  /** DuckLake schema within the catalog. Null = catalog's configured default. */
  schema?: string | null;
  /**
   * Result variant sharing the same cache prefix (e.g. 'with-count', 'with-metadata').
   * Included in the cache key after the versioned schema so that loaders returning
   * different shapes for the same parameters never share an entry, while the
   * invalidation patterns `prefix:catalog:schema@*:*` still match.
   */
  cacheVariant?: string | null;
  /**
   * Deadline (ms) of one batch: connection wait plus queries. When it expires
   * the running DuckDB query is interrupted and the connection released.
   * Aligned on the resolver timeout (API.TIMEOUTS) of the loader's consumer.
   */
  queryTimeout?: number;
}

/**
 * Runs a step on the batch's connection, acquired on first use and
 * interrupted when the batch deadline expires.
 */
export type RunOnConnection = <T>(step: (connection: DuckDBConnection) => Promise<T>) => Promise<T>;

/** Sort criterion for SQL ORDER BY clauses. */
interface SortItem {
  field: string;
  order: 'ASC' | 'DESC';
}

/** The (catalog, schema) segments a cache key is written under. */
interface CacheNamespace {
  catalog: string;
  schema: string;
}

/**
 * Recursively sorts object keys and drops `undefined`-valued properties, so
 * two semantically identical keys (e.g. `{catalog}` and
 * `{catalog, schema: undefined}`, or the same fields in a different order)
 * always serialize to the same string.
 *
 * @param value - Value to canonicalize (object, array, or scalar).
 * @returns The same value with objects normalized for stable serialization.
 */
// Canonicalisation : clés triées, valeurs undefined retirées — sérialisation stable
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const propertyKey of Object.keys(source).sort()) {
      if (source[propertyKey] !== undefined) {
        sorted[propertyKey] = canonicalize(source[propertyKey]);
      }
    }
    return sorted;
  }
  return value;
}

// Classe de base pour la requête d'une base de données
/**
 * Base class for all data loaders.
 *
 * Provides common functionality for database connection management,
 * Redis caching, and DataLoader creation. All concrete loaders extend
 * this class and use createLoader or createBatchLoader to build
 * their DataLoader instances. A load error is never turned into null:
 * it rejects the key(s) concerned (see toLoaderError).
 */
class BaseQueryLoader {
  batchSize: number;
  cachePrefix: string;
  cacheEnabled: boolean;
  cacheTimeout: number;
  catalogId: string | null;
  schema: string | null;
  cacheVariant: string | null;
  queryTimeout: number;

  // Initialisation des propriétés du loader
  /**
   * Creates a new BaseQueryLoader instance.
   *
   * @param config - Optional configuration overrides for the loader.
   */
  constructor(config: BaseLoaderConfig = {}) {
    this.batchSize = config.batchSize || 5;
    this.cachePrefix = config.cachePrefix || 'default';
    this.cacheEnabled = config.cache !== false;
    this.cacheTimeout = config.cacheTimeout || globalConfig.API.LOADERS.DEFAULT_CACHE_TIMEOUT;
    this.catalogId = config.catalogId ?? null;
    this.schema = config.schema ?? null;
    this.cacheVariant = config.cacheVariant ?? null;
    // Échéance par défaut : le plus long timeout de resolver
    this.queryTimeout = config.queryTimeout ?? globalConfig.API.TIMEOUTS.FACT_COMPLEX;
  }

  // Méthode exécutant un lot avec une connexion acquise à la demande
  /**
   * Runs a batch body with a connection acquired lazily, under a deadline.
   *
   * The body receives `run`: the first call acquires one connection from the
   * pool (shared by every later call of the batch), so a batch served
   * entirely from the cache never takes a connection. The deadline
   * (`queryTimeout`) starts now and covers both the wait in the pool queue
   * and the queries: when it expires, a queued acquisition leaves the queue
   * and a running query is interrupted (`connection.conn.interrupt()`), the
   * step then failing with the timeout error. The connection is released once
   * the body has settled — right after the interrupted query returns.
   *
   * @param body - Batch work, calling `run` for each database step.
   * @returns Result of body.
   * @throws Whatever body throws (timeout, acquisition or query error).
   */
  async withLazyConnection<T>(body: (run: RunOnConnection) => Promise<T>): Promise<T> {
    // Échéance du lot : attente dans la file comprise
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`${this.cachePrefix} query timeout after ${this.queryTimeout}ms`),
        ),
      this.queryTimeout,
    );
    let pool: DuckDBPool | undefined;
    let acquisition: Promise<DuckDBConnection> | undefined;

    // Acquisition unique, au premier besoin réel d'une connexion
    const connect = (): Promise<DuckDBConnection> => {
      if (!acquisition) {
        // Garde de version : un schéma non conforme est refusé avant toute requête.
        // Les loaders cross-catalog (catalogId null, catalogues passés en arguments)
        // appliquent la garde eux-mêmes sur chacune de leurs cibles.
        if (this.catalogId) {
          assertSchemaSupported(this.catalogId, this.resolvedSchema());
        }
        // Récupération du pool associé à l'identifiant de catalogue
        pool = databaseManager.getPool(this.catalogId);
        acquisition = pool.acquire(controller.signal);
      }
      return acquisition;
    };

    const run: RunOnConnection = async (step) => {
      const connection = await connect();
      return runInterruptible(connection, controller.signal, () => step(connection));
    };

    try {
      return await body(run);
    } catch (error) {
      logger.error(
        `Error in ${this.cachePrefix} loader (catalog: ${this.catalogId || 'default'}, schema: ${this.schema || 'default'}):`,
        error,
      );
      throw error;
    } finally {
      clearTimeout(timer);
      // Libération de la connexion si elle a été acquise
      if (acquisition && pool) {
        const connection = await acquisition.catch(() => undefined);
        if (connection) pool.release(connection);
      }
    }
  }

  // Méthode exécutant une fonction à partir d'une connexion à la base de données
  /**
   * Executes a function with a managed database connection.
   *
   * Acquires a connection from the pool before calling queryFn and releases
   * it afterwards, even when queryFn throws. The loader's `queryTimeout`
   * applies: past it, the query is interrupted (see {@link withLazyConnection}).
   *
   * @param queryFn - Async function that receives a DuckDB connection.
   * @returns Result of queryFn.
   * @throws {Error} When pool acquisition fails, queryFn throws or the deadline expires.
   */
  async executeWithConnection<T>(
    queryFn: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    return this.withLazyConnection((run) => run(queryFn));
  }

  // Méthode de qualification d'un nom de table avec le catalogue DuckLake courant
  /**
   * Returns a fully qualified table name for the current catalog and schema.
   *
   * With the DuckLake multi-catalog / multi-schema setup, all table names must
   * be prefixed as "{catalogId}"."{schema}"."{tableName}", each part quoted.
   * The schema is the one bound to this loader (per-request), falling back to
   * the catalog's configured default schema when none was provided.
   *
   * @param tableName - Bare table name (e.g. 'fact_table', 'metadata').
   * @returns Fully qualified table name string.
   */
  qualifyTable(tableName: string): string {
    const catalog = this.catalogId || databaseManager.getDefaultCatalog();
    return qualifiedTable(catalog, this.resolvedSchema(), tableName);
  }

  // Point d'extension : contrôle d'une clé avant toute lecture, cache compris
  /**
   * Validates one DataLoader key before any cache lookup or query.
   *
   * The base implementation accepts every key. Loaders whose catalog/schema
   * travels in the key — rather than being bound to the instance — override
   * this to apply the schema version guard. It must run BEFORE the cache is
   * consulted: a warm Redis entry would otherwise serve a schema the API has
   * declared unreadable.
   *
   * @param _key - The DataLoader key about to be loaded.
   */
  assertKeyAllowed(_key: unknown): void {
    // Aucun contrôle par défaut
  }

  // Point d'extension : durée de vie de l'entrée de cache d'une clé
  /**
   * Returns the cache TTL applied to the entry of one DataLoader key.
   *
   * The base implementation returns the loader-wide `cacheTimeout`. Loaders
   * whose keys have different volatilities (e.g. an unfiltered result that
   * only changes with the nightly refresh, against a filtered one that is
   * rarely asked twice) override it.
   *
   * @param _key - The DataLoader key about to be cached.
   * @returns TTL in the unit expected by `withCache`.
   */
  cacheTimeoutFor(_key: unknown): number {
    return this.cacheTimeout;
  }

  // Méthode de résolution du schéma effectif du loader
  /**
   * Returns the schema this loader actually reads.
   *
   * Falls back to the configured default schema of the loader's catalog when
   * the request did not pin one.
   *
   * @returns Effective DuckLake schema name.
   */
  resolvedSchema(): string {
    const catalog = this.catalogId || databaseManager.getDefaultCatalog();
    return this.schema || databaseManager.getDefaultSchema(catalog);
  }

  // Point d'extension : segments (catalog, schema) sous lesquels la clé est écrite
  /**
   * Returns the resolved (catalog, schema) pair a cache entry is written
   * under, for one DataLoader key.
   *
   * The base implementation returns the loader's own bound catalog/schema
   * (`this.catalogId`/`this.schema`, resolved to real names — never the
   * literal 'default'/'_' placeholders). Loaders whose catalog/schema travels
   * in the key rather than being bound to the instance (e.g. cross-catalog
   * loaders with `catalogId: null`) override this so their cache entries land
   * under the catalog/schema they actually read — which is what makes
   * `CacheInvalidationManager`'s per-catalog patterns (`<type>:<catalog>:<schema>@*:*`)
   * match them.
   *
   * @param _key - The DataLoader key about to be cached.
   * @returns The resolved catalog and schema for this key's cache entry.
   */
  cacheNamespace(_key: unknown): CacheNamespace {
    return {
      catalog: this.catalogId || databaseManager.getDefaultCatalog(),
      schema: this.resolvedSchema(),
    };
  }

  // Méthode de chargement de données avec mise en cache Redis
  /**
   * Loads data with optional Redis caching.
   *
   * On cache miss, calls loader(), stores the result, then returns it.
   * A Redis failure falls back to the loader (handled by `withCache`), and so
   * does a key that cannot be built; a loader error is never retried: it
   * belongs to the caller (a GraphQLError must reach the client, and
   * retrying a failed query would only run it twice).
   *
   * The cache key is `<prefix>:<catalog>:<schema>@<version>:<variant><hash>`,
   * where catalog/schema come from {@link cacheNamespace} (always resolved,
   * never 'default'/'_' placeholders — so `CacheInvalidationManager`'s
   * per-catalog patterns match every entry), version is the data version the
   * live instance serves for that schema (`DatabaseManager.getDataVersion`: a
   * catalog update moves every key of the schema, older entries simply expire)
   * and hash is the sha1 of the key object,
   * canonicalized (sorted, undefined fields dropped, catalog/schema
   * overwritten with their resolved form) so equivalent keys always collide
   * onto the same entry instead of the raw `JSON.stringify(key)` used before.
   *
   * @param key - Cache key (will be canonicalized and hashed).
   * @param loader - Async function that fetches the data on cache miss.
   * @returns Cached or freshly loaded data.
   * @throws Whatever the loader throws, unchanged.
   */
  async loadWithCache<T>(key: unknown, loader: () => Promise<T>): Promise<T> {
    if (!this.cacheEnabled) {
      return await loader();
    }

    // Initialisation de la clé de cache
    let cacheKey: string;
    try {
      // Le schéma fait partie de la clé : deux schémas d'un même catalogue ne
      // doivent jamais partager une entrée de cache (colonnes et modalités différentes).
      // La variante sépare les loaders d'un même préfixe renvoyant des formes différentes.
      const { catalog, schema } = this.cacheNamespace(key);
      const keyForHash =
        key !== null && typeof key === 'object' && !Array.isArray(key)
          ? { ...(key as Record<string, unknown>), catalog, schema }
          : { key, catalog, schema };
      const hash = createHash('sha1')
        .update(JSON.stringify(canonicalize(keyForHash)))
        .digest('hex');
      // Version des données servies dans l'espace de noms : une mise à jour du
      // catalogue rend les anciennes entrées inaccessibles (expiration par TTL)
      cacheKey = buildCacheKey(
        { prefix: this.cachePrefix, catalog, schema, variant: this.cacheVariant ?? '', hash },
        (c, s) => databaseManager.getDataVersion(c, s),
      );
    } catch (error) {
      // Clé impossible à construire : chargement direct, sans cache
      logger.error(`Cache key error in ${this.cachePrefix} loader:`, error);
      return await loader();
    }
    // Pannes Redis absorbées par withCache ; une erreur du loader remonte telle quelle
    return await withCache<T>(cacheKey, loader, this.cacheTimeoutFor(key));
  }

  // Méthode de création d'un DataLoader avec gestion du cache et de la connexion
  /**
   * Creates a DataLoader that processes one key per database call.
   *
   * Each key is loaded independently (with optional caching). The cache is
   * read before any connection is acquired: a batch served entirely from
   * Redis never touches the pool, and the misses of a batch share one
   * connection (see {@link withLazyConnection}). Use createBatchLoader when
   * the underlying query can handle multiple keys in a single round-trip.
   *
   * An error never becomes null: it is classified by toLoaderError and
   * returned as the value of the failing key, so DataLoader rejects that key
   * alone while the other keys of the batch resolve. A GraphQLError reaches
   * the client unchanged, a DuckDB error caused by the request becomes
   * BAD_USER_INPUT, and any other error is reported as INTERNAL_SERVER_ERROR
   * (with an errorId) by the server's formatError.
   *
   * @param loadFn - Function that fetches data for a single key.
   * @param options - Additional DataLoader options (overrides defaults).
   * @returns Configured DataLoader instance.
   */
  createLoader<K, V>(
    loadFn: (connection: DuckDBConnection, key: K) => Promise<V>,
    options: object = {},
  ): DataLoader<K, V, string> {
    return new DataLoader<K, V, string>(
      async (keys) => {
        return this.withLazyConnection(async (run) => {
          return Promise.all(
            keys.map(async (key): Promise<V | Error> => {
              try {
                // Contrôle de la clé avant le cache (garde de version)
                this.assertKeyAllowed(key);
                // Connexion acquise seulement si la clé doit être lue en base
                return await this.loadWithCache(key, () =>
                  run((connection) => loadFn(connection, key)),
                );
              } catch (error) {
                // L'erreur devient la valeur de la clé : DataLoader ne rejette
                // que cette clé, jamais de null silencieux
                logger.error(`Error loading ${this.cachePrefix} for key:`, key, error);
                return toLoaderError(error);
              }
            }),
          );
        });
      },
      {
        maxBatchSize: this.batchSize,
        cacheKeyFn: (key: K) => JSON.stringify(key),
        cache: true,
        ...options,
      },
    );
  }

  // Méthode de création d'un DataLoader pour les opérations batch optimisées
  /**
   * Creates a DataLoader optimized for batch database operations.
   *
   * Passes all queued keys to batchLoadFn in a single call, allowing
   * the implementation to issue one efficient SQL query per batch. A key
   * without a result resolves to null (no row); an error rejects every key
   * of the batch, classified by toLoaderError as in createLoader.
   *
   * @param batchLoadFn - Function that loads data for multiple keys at once.
   * @param options - Additional DataLoader options (overrides defaults).
   * @returns Configured DataLoader instance.
   */
  createBatchLoader<K, V>(
    batchLoadFn: (connection: DuckDBConnection, keys: readonly K[]) => Promise<(V | null)[]>,
    options: object = {},
  ): DataLoader<K, V, string> {
    return new DataLoader<K, V, string>(
      async (keys) => {
        return this.executeWithConnection(async (connection) => {
          try {
            // Optimisation en une seule requête pour toutes les clés
            const results = await batchLoadFn(connection, keys);
            // Alignement du résultat sur l'ordre des clés d'entrée ; une clé
            // sans ligne vaut null (absence de donnée, pas une erreur)
            return keys.map((_, index) => results[index] ?? (null as unknown as V));
          } catch (error) {
            // Mêmes règles que createLoader : l'erreur rejette les clés du lot
            logger.error(`Batch error in ${this.cachePrefix} loader:`, error);
            throw toLoaderError(error);
          }
        });
      },
      {
        maxBatchSize: this.batchSize,
        cacheKeyFn: (key: K) => JSON.stringify(key),
        cache: true,
        ...options,
      },
    );
  }
}

// Classe de base pour les loaders interrogeant la table des faits
/**
 * Base class for fact-related loaders.
 *
 * Extends BaseQueryLoader with SQL-building helpers specific to
 * fact table queries (SELECT clause, ORDER BY clause). Pagination bounds
 * are validated by the resolvers (utils/pagination.ts).
 */
class FactQueryLoader extends BaseQueryLoader {
  // Méthode de construction de la sélection des colonnes en SQL
  /**
   * Builds a SQL SELECT clause from a list of field names.
   *
   * Every field name is quoted; its existence was checked upstream against
   * the metadata table (assertColumns), so any column name works.
   *
   * @param fields - Array of column names to include in the SELECT.
   * @returns Comma-separated field list, or '*' when fields is empty or null.
   */
  buildSelectClause(fields: string[] | null | undefined): string {
    if (!fields || fields.length === 0) return '*';
    return fields.map(quoteIdent).join(', ');
  }

  // Méthode de construction de la clause d'ordonnancement SQL
  /**
   * Builds a SQL ORDER BY clause from sort configuration.
   *
   * Field names are quoted (their existence was checked upstream against the
   * metadata table, or against the output aliases of the query) and the
   * direction is restricted to ASC / DESC before interpolation.
   *
   * The lone `ALL_COLUMNS_SORT` item is rendered as `ORDER BY ALL`.
   *
   * @param sort - Array of sort items, each with a field name and direction.
   * @returns ORDER BY clause string, or empty string when sort is empty or null.
   * @throws {GraphQLError} When a direction is invalid.
   */
  buildSortClause(sort: SortItem[] | null | undefined): string {
    if (!sort || sort.length === 0) return '';
    if (sort.length === 1 && sort[0].field === ALL_COLUMNS_FIELD) return 'ORDER BY ALL';
    const items = sort.map((s) => {
      const field = quoteIdent(s.field);
      // Direction restreinte à ASC / DESC (défaut ASC)
      const order = s.order ?? 'ASC';
      if (order !== 'ASC' && order !== 'DESC') {
        throw new GraphQLError('Sort order must be either "ASC" or "DESC"', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      return `${field} ${order}`;
    });
    return `ORDER BY ${items.join(', ')}`;
  }
}

export { BaseQueryLoader, FactQueryLoader };
export type {
  BaseLoaderConfig,
  SortItem,
  DuckDBConnection,
  DuckDBPool,
  D3QueryResult,
  D3Metadata,
  CacheNamespace,
};
