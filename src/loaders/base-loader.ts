// Importation des modules
import DataLoader from 'dataloader';
import { GraphQLError } from 'graphql';
import { databaseManager } from '../db/index.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { withCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { config as globalConfig } from '../utils/config-loader.js';
import { validateIdentifier } from '../utils/utils.js';

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
  data: Record<string, unknown>[];
  metadata: D3Metadata;
}

/** Interface of a DuckDB connection wrapped by the connection pool. */
interface DuckDBConnection {
  all: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  getAsJsonArray: (query: string, params?: unknown[]) => Promise<unknown[][]>;
  getWithMetadata: (query: string, params?: unknown[]) => Promise<D3QueryResult>;
  exec: (query: string) => Promise<void>;
  close: () => Promise<void>;
  inUse: boolean;
  conn: unknown;
}

/** Interface of a DuckDB connection pool. */
interface DuckDBPool {
  acquire: () => Promise<DuckDBConnection>;
  release: (connection: DuckDBConnection) => void;
  close: () => Promise<void>;
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
   * Included in the cache key after the schema so that loaders returning different
   * shapes for the same parameters never share an entry, while the invalidation
   * patterns `prefix:catalog:schema:*` still match.
   */
  cacheVariant?: string | null;
}

/** Sort criterion for SQL ORDER BY clauses. */
interface SortItem {
  field: string;
  order: 'ASC' | 'DESC';
}

// Classe de base pour la requête d'une base de données
/**
 * Base class for all data loaders.
 *
 * Provides common functionality for database connection management,
 * Redis caching, and DataLoader creation. All concrete loaders extend
 * this class and use createLoader or createBatchLoader to build
 * their DataLoader instances.
 */
class BaseQueryLoader {
  batchSize: number;
  cachePrefix: string;
  cacheEnabled: boolean;
  cacheTimeout: number;
  catalogId: string | null;
  schema: string | null;
  cacheVariant: string | null;

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
  }

  // Méthode exécutant une fonction à partir d'une connexion à la base de données
  /**
   * Executes a function with a managed database connection.
   *
   * Acquires a connection from the pool before calling queryFn and
   * releases it in the finally block, even when queryFn throws.
   *
   * @param queryFn - Async function that receives a DuckDB connection.
   * @returns Result of queryFn.
   * @throws {Error} When pool acquisition fails or queryFn throws.
   */
  async executeWithConnection<T>(
    queryFn: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    let connection: DuckDBConnection | undefined;
    let pool: DuckDBPool | undefined;
    try {
      // Garde de version : un schéma non conforme est refusé avant toute requête.
      // Les loaders cross-catalog (catalogId null, catalogues passés en arguments)
      // appliquent la garde eux-mêmes sur chacune de leurs cibles.
      if (this.catalogId) {
        assertSchemaSupported(this.catalogId, this.resolvedSchema());
      }

      // Récupération du pool associé à l'identifiant de catalogue
      pool = (databaseManager as unknown as { getPool: (id: string | null) => DuckDBPool }).getPool(
        this.catalogId,
      );
      // Acquisition de la connexion
      connection = await pool.acquire();
      // Exécution de la fonction avec la connexion
      return await queryFn(connection);
    } catch (error) {
      logger.error(
        `Error in ${this.cachePrefix} loader (catalog: ${this.catalogId || 'default'}, schema: ${this.schema || 'default'}):`,
        error,
      );
      throw error;
    } finally {
      // Libération de la connexion dans tous les cas
      if (connection && pool) {
        pool.release(connection);
      }
    }
  }

  // Méthode de qualification d'un nom de table avec le catalogue DuckLake courant
  /**
   * Returns a fully qualified table name for the current catalog and schema.
   *
   * With the DuckLake multi-catalog / multi-schema setup, all table names must
   * be prefixed as "{catalogId}".{schema}.{tableName}. The schema is the one
   * bound to this loader (per-request), falling back to the catalog's configured
   * default schema when none was provided.
   *
   * @param tableName - Bare table name (e.g. 'fact_table', 'metadata').
   * @returns Fully qualified table name string.
   */
  qualifyTable(tableName: string): string {
    const catalog = this.catalogId || databaseManager.getDefaultCatalog();
    return `"${catalog}".${this.resolvedSchema()}.${tableName}`;
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

  // Méthode de chargement de données avec mise en cache Redis
  /**
   * Loads data with optional Redis caching.
   *
   * On cache miss, calls loader(), stores the result, then returns it.
   * Falls back to a direct loader call on a Redis error — but never on a
   * loader error: those belong to the caller (a GraphQLError must reach the
   * client, and retrying a failed query would only run it twice).
   *
   * @param key - Cache key (will be JSON-serialized).
   * @param loader - Async function that fetches the data on cache miss.
   * @returns Cached or freshly loaded data.
   * @throws Whatever the loader throws, unchanged.
   */
  async loadWithCache<T>(key: unknown, loader: () => Promise<T>): Promise<T> {
    if (!this.cacheEnabled) {
      return await loader();
    }

    // Distinction entre une panne du cache et une erreur du loader lui-même
    let loaderFailed = false;
    const guardedLoader = async (): Promise<T> => {
      try {
        return await loader();
      } catch (error) {
        loaderFailed = true;
        throw error;
      }
    };

    try {
      // Le schéma fait partie de la clé : deux schémas d'un même catalogue ne
      // doivent jamais partager une entrée de cache (colonnes et modalités différentes).
      // La variante sépare les loaders d'un même préfixe renvoyant des formes différentes.
      const variant = this.cacheVariant ? `${this.cacheVariant}:` : '';
      const cacheKey = `${this.cachePrefix}:${this.catalogId || 'default'}:${this.schema || '_'}:${variant}${JSON.stringify(key)}`;
      return await withCache<T>(cacheKey, guardedLoader, this.cacheTimeout);
    } catch (error) {
      // L'erreur vient du loader : elle appartient à l'appelant
      if (loaderFailed) throw error;
      logger.error(`Cache error in ${this.cachePrefix} loader:`, error);
      // En cas d'erreur de cache, exécution directe du loader
      return await loader();
    }
  }

  // Méthode de création d'un DataLoader avec gestion du cache et de la connexion
  /**
   * Creates a DataLoader that processes one key per database call.
   *
   * Each key is loaded independently (with optional caching). Use
   * createBatchLoader when the underlying query can handle multiple
   * keys in a single round-trip.
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
        return this.executeWithConnection(async (connection) => {
          return Promise.all(
            keys.map(async (key) => {
              try {
                // Contrôle de la clé avant le cache (garde de version)
                this.assertKeyAllowed(key);
                // Appel direct pour éviter la récursion dans le DataLoader
                if (!this.cacheEnabled) {
                  return await loadFn(connection, key);
                }
                return await this.loadWithCache(key, async () => await loadFn(connection, key));
              } catch (error) {
                // Les erreurs GraphQL (validation métier explicite) doivent
                // remonter au client ; sinon le filet ci-dessous masque le
                // vrai message en renvoyant null pour un champ non-nullable.
                if (error instanceof GraphQLError) throw error;
                logger.error(`Error loading ${this.cachePrefix} for key:`, key, error);
                // Retourne null ou tableau vide selon le contexte
                return (Array.isArray(key) ? [] : null) as unknown as V;
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
   * the implementation to issue one efficient SQL query per batch.
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
            // Alignement du résultat sur l'ordre des clés d'entrée
            return keys.map((_, index) => results[index] ?? (null as unknown as V));
          } catch (error) {
            // Mêmes règles que createLoader : les GraphQLError remontent.
            if (error instanceof GraphQLError) throw error;
            logger.error(`Batch error in ${this.cachePrefix} loader:`, error);
            // Valeurs par défaut pour chaque clé en cas d'erreur
            return keys.map(() => null as unknown as V);
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
 * fact table queries (SELECT clause, ORDER BY clause, pagination
 * validation).
 */
class FactQueryLoader extends BaseQueryLoader {
  // Méthode de construction de la sélection des colonnes en SQL
  /**
   * Builds a SQL SELECT clause from a list of field names.
   *
   * Every field name is validated as a SQL identifier before interpolation.
   *
   * @param fields - Array of column names to include in the SELECT.
   * @returns Comma-separated field list, or '*' when fields is empty or null.
   * @throws {GraphQLError} When a field name is not a valid identifier.
   */
  buildSelectClause(fields: string[] | null | undefined): string {
    if (!fields || fields.length === 0) return '*';
    // Validation de chaque colonne avant interpolation (anti-injection)
    return fields.map((f) => validateIdentifier(f, 'field')).join(', ');
  }

  // Méthode de construction de la clause d'ordonnancement SQL
  /**
   * Builds a SQL ORDER BY clause from sort configuration.
   *
   * Field names are validated as SQL identifiers and the direction is
   * restricted to ASC / DESC before interpolation.
   *
   * @param sort - Array of sort items, each with a field name and direction.
   * @returns ORDER BY clause string, or empty string when sort is empty or null.
   * @throws {GraphQLError} When a field name or direction is invalid.
   */
  buildSortClause(sort: SortItem[] | null | undefined): string {
    if (!sort || sort.length === 0) return '';
    const items = sort.map((s) => {
      const field = validateIdentifier(s.field, 'sortField');
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

  // Méthode de validation des paramètres de pagination
  /**
   * Validates that pagination parameters are within configured bounds.
   *
   * @param limit - Maximum number of rows to return.
   * @param offset - Number of rows to skip.
   * @throws {Error} When limit exceeds MAX_LIMIT or offset exceeds MAX_OFFSET.
   */
  validatePagination(limit: number, offset: number): void {
    if (limit > globalConfig.API.PAGINATION.MAX_LIMIT) {
      throw new Error(`Limit cannot exceed ${globalConfig.API.PAGINATION.MAX_LIMIT}`);
    }
    if (offset > globalConfig.API.PAGINATION.MAX_OFFSET) {
      throw new Error(`Offset cannot exceed ${globalConfig.API.PAGINATION.MAX_OFFSET}`);
    }
  }
}

export { BaseQueryLoader, FactQueryLoader };
export type { BaseLoaderConfig, SortItem, DuckDBConnection, DuckDBPool, D3QueryResult, D3Metadata };
