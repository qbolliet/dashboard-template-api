/**
 * Comprehensive integration test suite for cross-component interactions.
 *
 * Validates the integration of DI container, multi-database routing, security
 * pipeline, caching strategy, data loaders, request lifecycle, error handling,
 * and configuration management.
 */

// Suite d'intégration complète — validation des interactions entre composants.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { createTestContainer, DIContainer } from '../setup/di-container.js';

// ─── Interfaces partagées ──────────────────────────────────────────────────────

/** Configuration d'un catalogue DuckLake individuel. */
interface CatalogConfig {
  PATH: string;
  DATA_PATH: string;
  READ_ONLY: boolean;
}

/** Configuration du pool de connexions à la base de données. */
interface PoolConfig {
  MAX_CONNECTIONS: number;
  ACQUIRE_TIMEOUT: number;
  POOL_RETRY_DELAY: number;
}

/** Configuration multi-base complète générée par createDatabaseConfig. */
interface DatabaseConfig {
  DATABASE_ROUTING: {
    DEFAULT_DATABASE: string;
    ALLOWED_DATABASES: string[];
    ALLOW_CROSS_DATABASE_QUERIES: boolean;
  };
  CATALOGS: Record<string, CatalogConfig>;
  DATABASE: {
    POOL: PoolConfig;
  };
}

/** Requête de base avant routage. */
interface BaseQuery {
  operation: string;
  table: string;
  database?: string;
  databases?: string[];
}

/** Requête enrichie après routage — cible résolue. */
interface RoutedQuery extends BaseQuery {
  targetDatabase: string;
}

/** Requête GraphQL avec champs et profondeur pour l'analyse de complexité. */
interface GraphQLQuery {
  fields?: string[];
  depth?: number;
}

/** Résultat du pipeline de sécurité après validation et assainissement. */
interface SecurityPipelineResult {
  query: GraphQLQuery;
  variables: Record<string, unknown>;
  complexity: number;
}

/** Valeur pouvant être assainie récursivement par le sanitizer. */
type SanitizableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SanitizableValue[]
  | Record<string, SanitizableValue>;

/** Entrée de cache avec valeur et horodatage d'expiration. */
interface CacheEntry<T = unknown> {
  value: T;
  expires: number;
}

/** Élément dans la file de batching du DataLoader. */
interface BatchQueueItem<T> {
  key: string;
  resolve: (value: T) => void;
}

/** Instance de DataLoader avec méthode load et cache interne. */
interface DataLoaderInstance<T> {
  load: (key: string) => Promise<T>;
  cache: Map<string, T>;
}

/** Corps d'une requête HTTP entrante vers l'API GraphQL. */
interface RequestBody {
  query?: string;
  operationType?: string;
}

/** Requête HTTP entrante simulée. */
interface HttpRequest {
  body?: RequestBody;
  clientId?: string;
}

/** Enregistrement d'un événement de sécurité dans le log. */
interface SecurityLogEntry {
  event: string;
  query: string;
}

/** Enregistrement d'un appel au résolveur dans le log. */
interface ResolverLogEntry {
  event: string;
  rows: number;
}

/** Réponse API formatée renvoyée au client. */
interface ApiResponse<T = unknown> {
  data: T | null;
  errors?: Array<{ message: string }>;
}

/** Résultat d'une exécution sécurisée avec code d'erreur et indicateur de retry. */
interface SafeExecuteResult {
  data?: string;
  error?: string;
  retry?: boolean;
}

/** Erreur métier étendue avec code et indicateur de retryabilité. */
interface AppError extends Error {
  code?: string;
  retryable?: boolean;
}

/** Erreur formatée pour la réponse au client. */
interface FormattedError {
  message: string;
  code: string;
  retryable: boolean;
}

/** Configuration applicative de base (database, cache, sécurité). */
interface AppConfig {
  database: { host: string; port?: number; ssl?: boolean };
  cache: { ttl: number };
  security: { enabled: boolean };
}

/** Objet générique récursif — utilisé pour la fusion profonde de configuration. */
type DeepRecord = Record<string, unknown>;

// ─── Suite principale ──────────────────────────────────────────────────────────

describe('Comprehensive API Integration Tests', () => {
  let container: DIContainer;

  beforeEach(() => {
    // Création d'un conteneur isolé pour chaque test
    container = createTestContainer();
  });

  // ─── Dependency Injection Container ───────────────────────────────────────────

  describe('Dependency Injection Container', () => {
    test('should register and resolve services', () => {
      const mockService = { name: 'test-service' };

      container.register('test', () => mockService);

      const resolved = container.get('test');
      expect(resolved).toBe(mockService);
    });

    test('should handle singleton services', () => {
      let counter = 0;

      container.singleton('counter', () => ({ count: ++counter }));

      const instance1 = container.get<{ count: number }>('counter');
      const instance2 = container.get<{ count: number }>('counter');

      expect(instance1).toBe(instance2);
      expect(instance1.count).toBe(1);
    });

    test('should resolve dependencies', () => {
      container.register('config', () => ({ api: { port: 3000 } }));
      container.register('logger', () => ({ log: jest.fn() }));
      container.register('server', (config, logger) => {
        return { config, logger, start: jest.fn() };
      }, { dependencies: ['config', 'logger'] });

      const server = container.get<{
        config: { api: { port: number } };
        logger: { log: ReturnType<typeof jest.fn> };
        start: ReturnType<typeof jest.fn>;
      }>('server');

      expect(server.config.api.port).toBe(3000);
      expect(server.logger.log).toBeDefined();
    });

    test('should support mocking for tests', () => {
      const realService = { real: true };
      const mockService = { real: false, mock: true };

      container.register('service', () => realService);
      expect(container.get<typeof realService>('service').real).toBe(true);

      container.mock('service', mockService);
      expect(container.get<typeof mockService>('service').real).toBe(false);
      expect(container.get<typeof mockService>('service').mock).toBe(true);

      container.unmock('service');
      expect(container.get<typeof realService>('service').real).toBe(true);
    });

    test('should throw when resolving an unregistered service', () => {
      expect(() => container.get('nonexistent')).toThrow("Service 'nonexistent' not found");
    });

    test('should list all registered service names', () => {
      container.register('alpha', () => ({}));
      container.singleton('beta', () => ({}));
      container.instance('gamma', {});

      const names = container.getServiceNames();
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toContain('gamma');
    });

    test('should clear all services', () => {
      container.register('svc', () => ({}));
      container.clear();
      expect(container.has('svc')).toBe(false);
    });
  });

  // ─── Multi-Database Architecture ───────────────────────────────────────────────

  describe('Multi-Database Architecture Tests', () => {
    test('should support multiple database configurations', () => {
      /**
       * Build a database configuration object from a catalog map.
       *
       * Args:
       *     catalogs: Map of catalog name to catalog configuration.
       *
       * Returns:
       *     Complete DatabaseConfig object with routing and pool settings.
       */
      const createDatabaseConfig = (catalogs: Record<string, CatalogConfig>): DatabaseConfig => ({
        DATABASE_ROUTING: {
          DEFAULT_DATABASE: 'main',
          ALLOWED_DATABASES: Object.keys(catalogs),
          ALLOW_CROSS_DATABASE_QUERIES: true
        },
        CATALOGS: catalogs,
        DATABASE: {
          POOL: { MAX_CONNECTIONS: 10, ACQUIRE_TIMEOUT: 5000, POOL_RETRY_DELAY: 100 }
        }
      });

      const config = createDatabaseConfig({
        main:      { PATH: 'data/main.ducklake',      DATA_PATH: 'data/main_data/',      READ_ONLY: true },
        analytics: { PATH: 'data/analytics.ducklake', DATA_PATH: 'data/analytics_data/', READ_ONLY: true },
        archive:   { PATH: 'data/archive.ducklake',   DATA_PATH: 'data/archive_data/',   READ_ONLY: true }
      });

      expect(config.DATABASE_ROUTING.ALLOWED_DATABASES).toHaveLength(3);
      expect(config.CATALOGS).toHaveProperty('main');
      expect(config.CATALOGS).toHaveProperty('analytics');
      expect(config.CATALOGS).toHaveProperty('archive');
      expect(config.DATABASE.POOL.MAX_CONNECTIONS).toBe(10);
    });

    test('should route queries to correct databases', () => {
      const allowedDatabases: string[] = ['main', 'analytics', 'archive'];

      // Routeur de requête — résolution de la base de données cible selon priorité
      const queryRouter = {
        /**
         * Route a query to the appropriate database.
         *
         * Args:
         *     query: Base query with optional explicit database override.
         *     databaseHint: Hint from the request header or query param.
         *     userDatabase: User's preferred database from session.
         *     defaultDatabase: System fallback database.
         *
         * Returns:
         *     Routed query with resolved targetDatabase field.
         *
         * Raises:
         *     Error: When the resolved database is not in the allowed list.
         */
        route: (
          query: BaseQuery,
          databaseHint: string | null,
          userDatabase: string | null,
          defaultDatabase: string
        ): RoutedQuery => {
          const targetDb = query.database ?? databaseHint ?? userDatabase ?? defaultDatabase;

          if (!allowedDatabases.includes(targetDb)) {
            throw new Error(`Invalid database: ${targetDb}`);
          }

          return { ...query, targetDatabase: targetDb };
        }
      };

      const baseQuery: BaseQuery = { operation: 'SELECT', table: 'facts' };

      expect(queryRouter.route(baseQuery, null, null, 'main').targetDatabase).toBe('main');
      expect(queryRouter.route(baseQuery, 'analytics', null, 'main').targetDatabase).toBe('analytics');
      expect(queryRouter.route({ ...baseQuery, database: 'archive' }, 'analytics', null, 'main').targetDatabase).toBe('archive');

      expect(() => queryRouter.route(baseQuery, 'invalid', null, 'main')).toThrow('Invalid database: invalid');
    });

    test('should prevent cross-database queries when disabled', () => {
      const config = { ALLOW_CROSS_DATABASE_QUERIES: false, DEFAULT_DATABASE: 'main' };

      /**
       * Validate that a query does not span multiple databases when cross-DB is off.
       *
       * Args:
       *     query: Query with optional databases array.
       *     cfg: Configuration object with cross-DB flag.
       *
       * Returns:
       *     True if the query is valid.
       *
       * Raises:
       *     Error: When cross-database queries are disabled and multiple databases used.
       */
      const validateCrossDbQuery = (
        query: BaseQuery,
        cfg: { ALLOW_CROSS_DATABASE_QUERIES: boolean; DEFAULT_DATABASE: string }
      ): boolean => {
        if (!cfg.ALLOW_CROSS_DATABASE_QUERIES && query.databases && query.databases.length > 1) {
          throw new Error('Cross-database queries are disabled');
        }
        return true;
      };

      expect(() => validateCrossDbQuery({ databases: ['main', 'analytics'], operation: 'SELECT', table: 'facts' }, config))
        .toThrow('Cross-database queries are disabled');
      expect(validateCrossDbQuery({ databases: ['main'], operation: 'SELECT', table: 'facts' }, config)).toBe(true);
    });
  });

  // ─── Security Pipeline Integration ────────────────────────────────────────────

  describe('Security Pipeline Integration', () => {
    test('should integrate all security components', async () => {
      // Composants du pipeline de sécurité — rate limiter, analyseur de complexité, sanitizer
      const rateLimiter = {
        check: async (_clientId: string, _limit = 100): Promise<boolean> => true
      };

      const complexityAnalyzer = {
        /**
         * Compute the complexity score of a GraphQL query.
         *
         * Args:
         *     query: GraphQL query descriptor with fields and depth.
         *
         * Returns:
         *     Numeric complexity score (fields × depth).
         */
        analyze: (query: GraphQLQuery): number => {
          const baseComplexity = query.fields ? query.fields.length : 1;
          const depthMultiplier = query.depth ?? 1;
          return baseComplexity * depthMultiplier;
        }
      };

      const inputSanitizer = {
        /**
         * Strip dangerous HTML/script content from a string input.
         *
         * Args:
         *     input: Raw value to sanitize.
         *
         * Returns:
         *     Sanitized value (same type as input for non-strings).
         */
        sanitize: (input: unknown): unknown => {
          if (typeof input === 'string') {
            return input
              .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
              .replace(/javascript:/gi, '');
          }
          return input;
        }
      };

      /**
       * Execute the full security pipeline for an incoming request.
       *
       * Args:
       *     request: Incoming request with clientId.
       *     query: GraphQL query descriptor.
       *     variables: Raw query variables to sanitize.
       *
       * Returns:
       *     Processed result with sanitized variables and complexity score.
       *
       * Raises:
       *     Error: When rate limit exceeded or query complexity too high.
       */
      const securityPipeline = async (
        request: { clientId: string },
        query: GraphQLQuery,
        variables: Record<string, string>
      ): Promise<SecurityPipelineResult> => {
        const rateLimitPassed = await rateLimiter.check(request.clientId);
        if (!rateLimitPassed) throw new Error('Rate limit exceeded');

        const complexity = complexityAnalyzer.analyze(query);
        if (complexity > 1000) throw new Error('Query too complex');

        // Assainissement de chaque variable — élimination du contenu dangereux
        const sanitizedVariables: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(variables)) {
          sanitizedVariables[key] = inputSanitizer.sanitize(value);
        }

        return { query, variables: sanitizedVariables, complexity };
      };

      const result = await securityPipeline(
        { clientId: 'user123' },
        { fields: ['name', 'email'], depth: 2 },
        { search: 'john doe' }
      );
      expect(result.complexity).toBe(4); // 2 champs × 2 profondeur
      expect(result.variables.search).toBe('john doe');

      const sanitized = await securityPipeline(
        { clientId: 'user123' },
        { fields: ['name', 'email'], depth: 2 },
        { search: '<script>alert("xss")</script>search term' }
      );
      expect(sanitized.variables.search).not.toContain('<script>');
      expect(sanitized.variables.search).toContain('search term');
    });

    test('should block queries exceeding complexity threshold', async () => {
      const complexityAnalyzer = {
        analyze: (query: GraphQLQuery): number =>
          (query.fields?.length ?? 0) * (query.depth ?? 1)
      };

      /**
       * Run a query through the complexity gate.
       *
       * Args:
       *     query: GraphQL query descriptor.
       *
       * Returns:
       *     Object with computed complexity score.
       *
       * Raises:
       *     Error: When complexity exceeds 1000.
       */
      const pipeline = async (query: GraphQLQuery): Promise<{ complexity: number }> => {
        const complexity = complexityAnalyzer.analyze(query);
        if (complexity > 1000) throw new Error('Query too complex');
        return { complexity };
      };

      await expect(pipeline({ fields: Array(101).fill('field'), depth: 11 }))
        .rejects.toThrow('Query too complex');
      await expect(pipeline({ fields: ['name', 'value'], depth: 3 }))
        .resolves.toMatchObject({ complexity: 6 });
    });

    test('should sanitize all variable types', async () => {
      /**
       * Recursively sanitize a value by stripping HTML tags and javascript: URIs.
       *
       * Args:
       *     value: Raw value — string, array, object, or primitive.
       *
       * Returns:
       *     Sanitized value with the same structure.
       */
      const sanitize = (value: SanitizableValue): SanitizableValue => {
        if (typeof value === 'string') {
          return value.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').trim();
        }
        if (Array.isArray(value)) return value.map(sanitize);
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value as Record<string, SanitizableValue>).map(([k, v]) => [k, sanitize(v)])
          );
        }
        return value;
      };

      expect(sanitize('<b>bold</b>')).toBe('bold');
      expect(sanitize(['<i>a</i>', 'clean'])).toEqual(['a', 'clean']);
      expect(sanitize({ label: '<em>tag</em>', count: 42 })).toEqual({ label: 'tag', count: 42 });
      expect(sanitize(42)).toBe(42);
    });
  });

  // ─── Caching Strategy ─────────────────────────────────────────────────────────

  describe('Caching Strategy Tests', () => {
    test('should implement multi-level caching', async () => {
      const cache = new Map<string, CacheEntry>();

      // Gestionnaire de cache — génération de clés, lecture, écriture et invalidation
      const cacheManager = {
        /**
         * Generate a namespaced cache key.
         *
         * Args:
         *     prefix: Cache namespace (e.g. 'metadata', 'facts').
         *     database: Target database identifier.
         *     params: Query parameters serialized into the key.
         *
         * Returns:
         *     Colon-delimited cache key string.
         */
        generateKey: (prefix: string, database: string, params: Record<string, unknown>): string =>
          `${prefix}:${database}:${JSON.stringify(params)}`,

        get: async (key: string): Promise<CacheEntry | undefined> => cache.get(key),

        set: async (key: string, value: unknown, ttl = 300_000): Promise<boolean> => {
          cache.set(key, { value, expires: Date.now() + ttl });
          return true;
        },

        // Invalidation par motif glob — 'prefix:db:*' converti en regex 'prefix:db:.*'
        invalidatePattern: async (pattern: string): Promise<number> => {
          const regex = new RegExp(pattern.replace('*', '.*'));
          const keysToDelete = Array.from(cache.keys()).filter(key => regex.test(key));
          keysToDelete.forEach(key => cache.delete(key));
          return keysToDelete.length;
        }
      };

      const key1 = cacheManager.generateKey('metadata', 'main', { field: 'country' });
      const key2 = cacheManager.generateKey('metadata', 'main', { field: 'indicator' });
      const key3 = cacheManager.generateKey('facts', 'main', { limit: 100 });

      expect(key1).toBe('metadata:main:{"field":"country"}');

      await cacheManager.set(key1, { name: 'country', type: 'categorical' });
      await cacheManager.set(key2, { name: 'indicator', type: 'categorical' });
      await cacheManager.set(key3, [{ id: 1, value: 100 }]);

      expect(cache.size).toBe(3);

      // Invalidation par motif glob : 'metadata:main:*' → regex 'metadata:main:.*'
      const invalidated = await cacheManager.invalidatePattern('metadata:main:*');
      expect(invalidated).toBe(2);
      expect(cache.size).toBe(1); // Seule la clé 'facts' subsiste
    });

    test('should handle cache invalidation per database', async () => {
      const multiDbCache = new Map<string, string>();

      // Clés de cache couvrant plusieurs bases de données et namespaces
      const cacheKeys: string[] = [
        'metadata:main:field1',
        'metadata:test:field1',
        'facts:main:query1',
        'facts:test:query1',
        'dimension:main:country',
        'dimension:analytics:country'
      ];

      cacheKeys.forEach(key => multiDbCache.set(key, `value-${key}`));
      expect(multiDbCache.size).toBe(6);

      // Suppression de toutes les entrées appartenant à la base 'main'
      const mainPattern = /.*:main:.*/;
      const mainKeys = Array.from(multiDbCache.keys()).filter(key => mainPattern.test(key));
      mainKeys.forEach(key => multiDbCache.delete(key));

      expect(multiDbCache.size).toBe(3);
      expect(Array.from(multiDbCache.keys())).toEqual([
        'metadata:test:field1',
        'facts:test:query1',
        'dimension:analytics:country'
      ]);
    });

    test('should not serve expired cache entries', async () => {
      const cache = new Map<string, CacheEntry>();

      const cacheManager = {
        set: (key: string, value: unknown, ttl: number): void => {
          cache.set(key, { value, expires: Date.now() + ttl });
        },
        get: (key: string): unknown => {
          const entry = cache.get(key);
          if (!entry) return null;
          // Éviction à l'accès si l'entrée a expiré
          if (Date.now() > entry.expires) {
            cache.delete(key);
            return null;
          }
          return entry.value;
        }
      };

      // Entrée avec TTL déjà écoulé — doit être évincée à l'accès
      cacheManager.set('expired-key', { data: 'stale' }, -1000);
      expect(cacheManager.get('expired-key')).toBeNull();
      expect(cache.has('expired-key')).toBe(false);

      // Entrée avec TTL valide — doit être retournée normalement
      cacheManager.set('fresh-key', { data: 'fresh' }, 60_000);
      expect(cacheManager.get('fresh-key')).toEqual({ data: 'fresh' });
    });

    test('should fall back to loader on cache miss', async () => {
      const cache = new Map<string, unknown>();
      const dbLoader = jest.fn().mockResolvedValue([{ id: 1, name: 'France' }]);

      /**
       * Retrieve from cache or populate via loader on miss.
       *
       * Args:
       *     key: Cache key to look up.
       *     loaderFn: Async function called on cache miss.
       *     ttl: Time-to-live for new cache entries (ms).
       *
       * Returns:
       *     Cached or freshly loaded value.
       */
      const withCache = async (key: string, loaderFn: () => Promise<unknown>, _ttl = 300_000): Promise<unknown> => {
        if (cache.has(key)) return cache.get(key);
        const result = await loaderFn();
        cache.set(key, result);
        return result;
      };

      const result1 = await withCache('dimensions:main:country', dbLoader as () => Promise<unknown>, 300_000);
      const result2 = await withCache('dimensions:main:country', dbLoader as () => Promise<unknown>, 300_000);

      expect(dbLoader).toHaveBeenCalledTimes(1); // Deuxième appel servi depuis le cache
      expect(result1).toBe(result2); // Même référence depuis le cache
    });
  });

  // ─── Data Loader Integration ───────────────────────────────────────────────────

  describe('Data Loader Integration', () => {
    test('should batch and cache data loading', async () => {
      /** Métadonnées d'un champ (nom et type). */
      interface FieldMetadata {
        name: string;
        type: string;
      }

      const mockDatabase = {
        metadata: new Map<string, FieldMetadata>([
          ['field1', { name: 'field1', type: 'string' }],
          ['field2', { name: 'field2', type: 'number' }],
          ['field3', { name: 'field3', type: 'boolean' }]
        ])
      };

      /**
       * Create a simple DataLoader with batching and caching.
       *
       * Args:
       *     batchLoadFn: Function accepting an array of keys and returning ordered results.
       *
       * Returns:
       *     DataLoader instance with load() method and internal cache.
       */
      const createDataLoader = <T>(
        batchLoadFn: (keys: string[]) => Promise<(T | undefined)[]>
      ): DataLoaderInstance<T | undefined> => {
        const loaderCache = new Map<string, T | undefined>();
        let batchQueue: BatchQueueItem<T | undefined>[] = [];
        let batchTimer: ReturnType<typeof setTimeout> | null = null;

        const load = async (key: string): Promise<T | undefined> => {
          if (loaderCache.has(key)) return loaderCache.get(key);

          return new Promise<T | undefined>((resolve) => {
            batchQueue.push({ key, resolve });

            if (!batchTimer) {
              batchTimer = setTimeout(async () => {
                const currentBatch = [...batchQueue];
                batchQueue = [];
                batchTimer = null;

                const keys = currentBatch.map(item => item.key);
                const results = await batchLoadFn(keys);

                // Distribution des résultats et mise en cache
                currentBatch.forEach((item, index) => {
                  loaderCache.set(item.key, results[index]);
                  item.resolve(results[index]);
                });
              }, 10);
            }
          });
        };

        return { load, cache: loaderCache };
      };

      const metadataLoader = createDataLoader<FieldMetadata>(async (keys) =>
        keys.map(key => mockDatabase.metadata.get(key))
      );

      const results = await Promise.all([
        metadataLoader.load('field1'),
        metadataLoader.load('field2'),
        metadataLoader.load('field1') // Appui sur le cache — même référence attendue
      ]);

      expect(results[0]?.name).toBe('field1');
      expect(results[1]?.name).toBe('field2');
      expect(results[2]).toBe(results[0]); // Même référence depuis le cache
      expect(metadataLoader.cache.size).toBe(2);
    });

    test('should deduplicate concurrent requests for the same key', async () => {
      let fetchCount = 0;
      const slowFetch = jest.fn(async () => {
        fetchCount++;
        return { value: 'result' };
      });

      // Déduplication des requêtes en vol — même clé → même promesse
      const inFlightRequests = new Map<string, Promise<{ value: string }>>();

      const deduplicatedFetch = async (key: string): Promise<{ value: string }> => {
        if (inFlightRequests.has(key)) return inFlightRequests.get(key)!;
        const promise = (slowFetch as () => Promise<{ value: string }>)(key);
        inFlightRequests.set(key, promise);
        promise.finally(() => inFlightRequests.delete(key));
        return promise;
      };

      const [r1, r2, r3] = await Promise.all([
        deduplicatedFetch('key1'),
        deduplicatedFetch('key1'),
        deduplicatedFetch('key1')
      ]);

      expect(slowFetch).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
    });
  });

  // ─── Resolver + DataLoader Pipeline ───────────────────────────────────────────

  describe('Resolver and DataLoader Pipeline Integration', () => {
    test('should resolve fields using DataLoader across multiple resolvers', async () => {
      /** Dimension pays résolue par le loader. */
      interface CountryDimension {
        id: string;
        name: string;
        code: string;
      }

      /** Ligne de faits avant résolution de la dimension. */
      interface FactRow {
        id: number;
        countryId: string;
        value: number;
      }

      /** Ligne de faits après résolution de la dimension. */
      interface ResolvedFactRow extends FactRow {
        country: CountryDimension;
      }

      const batchLoadFn = jest.fn(async (keys: string[]) =>
        keys.map(id => ({ id, name: `Country-${id}`, code: id.toUpperCase() }))
      );

      const loaderCache = new Map<string, CountryDimension>();
      const inFlight = new Map<string, Promise<CountryDimension>>();

      // Chargeur de dimension avec déduplication et cache interne
      const dimensionLoader = {
        load: (id: string): Promise<CountryDimension> => {
          if (loaderCache.has(id)) return Promise.resolve(loaderCache.get(id)!);
          if (inFlight.has(id)) return inFlight.get(id)!;

          const promise = (batchLoadFn as (keys: string[]) => Promise<CountryDimension[]>)([id]).then(([result]) => {
            loaderCache.set(id, result);
            inFlight.delete(id);
            return result;
          });
          inFlight.set(id, promise);
          return promise;
        }
      };

      // Simulation de plusieurs résolveurs pour des lignes de faits — dimension partagée
      const factRows: FactRow[] = [
        { id: 1, countryId: 'fr', value: 100 },
        { id: 2, countryId: 'de', value: 200 },
        { id: 3, countryId: 'fr', value: 300 } // Même pays que la ligne 1 → cache hit
      ];

      const resolved: ResolvedFactRow[] = await Promise.all(
        factRows.map(async (row) => ({
          ...row,
          country: await dimensionLoader.load(row.countryId)
        }))
      );

      expect(resolved[0].country.name).toBe('Country-fr');
      expect(resolved[2].country).toBe(resolved[0].country); // Même objet depuis le cache
      expect(loaderCache.size).toBe(2); // 'fr' et 'de' uniquement
    });

    test('should propagate database context from request to loader', async () => {
      /** Loader contextuel associé à un identifiant de base de données. */
      interface ContextualLoader {
        databaseId: string;
        load: ReturnType<typeof jest.fn>;
      }

      /** Contexte de résolution contenant les loaders par type. */
      interface ResolverContext {
        databaseId: string;
        loaders: {
          metadata: ContextualLoader;
          dimensions: ContextualLoader;
        };
      }

      const createLoaderWithContext = (databaseId: string): ContextualLoader => ({
        databaseId,
        load: jest.fn(async (key: string) => ({ key, source: databaseId }))
      });

      /**
       * Build a resolver context with loaders bound to the target database.
       *
       * Args:
       *     databaseHint: Requested database identifier from client.
       *     availableDatabases: List of valid database names.
       *     defaultDatabase: Fallback database name when hint is invalid.
       *
       * Returns:
       *     Resolver context with resolved databaseId and bound loaders.
       */
      const createContext = (
        databaseHint: string,
        availableDatabases: string[],
        defaultDatabase: string
      ): ResolverContext => {
        const targetDb = availableDatabases.includes(databaseHint) ? databaseHint : defaultDatabase;
        return {
          databaseId: targetDb,
          loaders: {
            metadata: createLoaderWithContext(targetDb),
            dimensions: createLoaderWithContext(targetDb)
          }
        };
      };

      const ctxMain      = createContext('main',    ['main', 'analytics'], 'main');
      const ctxAnalytics = createContext('analytics', ['main', 'analytics'], 'main');
      const ctxInvalid   = createContext('unknown',  ['main', 'analytics'], 'main');

      expect(ctxMain.databaseId).toBe('main');
      expect(ctxAnalytics.databaseId).toBe('analytics');
      expect(ctxInvalid.databaseId).toBe('main'); // Retour sur la base par défaut

      const result = await (ctxAnalytics.loaders.metadata.load as (key: string) => Promise<{ key: string; source: string }>)('field1');
      expect(result.source).toBe('analytics');
    });
  });

  // ─── Full Request Lifecycle ────────────────────────────────────────────────────

  describe('Full Request Lifecycle Integration', () => {
    /**
     * Assemble the full request-processing pipeline.
     *
     * Returns:
     *     Object containing handleRequest function and audit logs.
     */
    const buildRequestPipeline = (): {
      handleRequest: (request: HttpRequest, context: object) => Promise<ApiResponse>;
      securityLog: SecurityLogEntry[];
      resolverLog: ResolverLogEntry[];
    } => {
      const securityLog: SecurityLogEntry[] = [];
      const resolverLog: ResolverLogEntry[] = [];

      const security = {
        validateRequest: async (request: HttpRequest): Promise<void> => {
          if (request.body?.operationType === 'mutation') {
            throw new Error('Mutations are not allowed');
          }
          if (!request.body?.query) {
            throw new Error('Missing query');
          }
          securityLog.push({ event: 'validated', query: request.body.query });
        }
      };

      const resolver = async (
        query: string,
        context: { database: { query: (q: string) => Array<Record<string, unknown>> } }
      ): Promise<Array<Record<string, unknown>>> => {
        const data = context.database.query(query);
        resolverLog.push({ event: 'resolved', rows: data.length });
        return data;
      };

      const formatResponse = (
        data: unknown,
        errors: Error[] = []
      ): ApiResponse => ({
        data: errors.length === 0 ? data as unknown[] : null,
        errors: errors.length > 0 ? errors.map(e => ({ message: e.message })) : undefined
      });

      const handleRequest = async (request: HttpRequest, context: object): Promise<ApiResponse> => {
        const errors: Error[] = [];
        try {
          await security.validateRequest(request);
          const data = await resolver(
            request.body!.query!,
            context as { database: { query: (q: string) => Array<Record<string, unknown>> } }
          );
          return formatResponse(data);
        } catch (err) {
          errors.push(err as Error);
          return formatResponse(null, errors);
        }
      };

      return { handleRequest, securityLog, resolverLog };
    };

    test('should process a valid query through the full pipeline', async () => {
      const { handleRequest, securityLog, resolverLog } = buildRequestPipeline();

      const context = {
        database: { query: (_q: string) => [{ id: 1, value: 100 }, { id: 2, value: 200 }] }
      };

      const response = await handleRequest(
        { body: { query: 'query { facts { id value } }', operationType: 'query' } },
        context
      );

      expect(response.data).toHaveLength(2);
      expect(response.errors).toBeUndefined();
      expect(securityLog).toHaveLength(1);
      expect(resolverLog[0].rows).toBe(2);
    });

    test('should reject mutation requests at the security layer', async () => {
      const { handleRequest, resolverLog } = buildRequestPipeline();

      const response = await handleRequest(
        { body: { query: 'mutation { createFact }', operationType: 'mutation' } },
        {}
      );

      expect(response.data).toBeNull();
      expect(response.errors).toHaveLength(1);
      expect(response.errors![0].message).toContain('not allowed');
      expect(resolverLog).toHaveLength(0); // Résolveur jamais appelé
    });

    test('should reject requests with missing query body', async () => {
      const { handleRequest } = buildRequestPipeline();

      const response = await handleRequest({ body: {} }, {});

      expect(response.data).toBeNull();
      expect(response.errors![0].message).toContain('Missing query');
    });
  });

  // ─── Error Handling and Resilience ────────────────────────────────────────────

  describe('Error Handling and Resilience', () => {
    test('should handle database failover', async () => {
      /** Pool de connexion à une base de données — état de santé et méthode de requête. */
      interface DatabasePool {
        healthy: boolean;
        error?: string;
        query?: ReturnType<typeof jest.fn>;
      }

      const databasePools: Record<string, DatabasePool> = {
        main:    { healthy: false, error: 'Connection lost' },
        backup:  { healthy: true, query: jest.fn().mockResolvedValue([{ id: 1 }]) },
        archive: { healthy: true, query: jest.fn().mockResolvedValue([]) }
      };

      /**
       * Execute a SQL query with automatic database failover.
       *
       * Args:
       *     sql: SQL statement to execute.
       *     preferredDb: Name of the preferred database (tried first).
       *
       * Returns:
       *     Query results from the first healthy database.
       *
       * Raises:
       *     Error: When all databases in the fallback chain are unavailable.
       */
      const queryWithFailover = async (sql: string, preferredDb = 'main'): Promise<unknown[]> => {
        // Ordre de tentative — préféré en premier, doublons supprimés
        const tryDatabases = [preferredDb, 'backup', 'archive'].filter(
          (db, index, arr) => arr.indexOf(db) === index
        );

        for (const dbName of tryDatabases) {
          const db = databasePools[dbName];
          if (db?.healthy) {
            try {
              return await (db.query as ReturnType<typeof jest.fn>)(sql);
            } catch {
              // Passage à la base de données suivante en cas d'erreur
            }
          }
        }

        throw new Error('All databases unavailable');
      };

      const result = await queryWithFailover('SELECT * FROM facts', 'main');
      expect(result).toEqual([{ id: 1 }]);
      expect(databasePools.backup.query).toHaveBeenCalled();
    });

    test('should throw when all databases are unavailable', async () => {
      const pools = {
        main:   { healthy: false },
        backup: { healthy: false }
      };

      const query = async (): Promise<unknown> => {
        for (const db of Object.values(pools)) {
          if (db.healthy) return await (db as { healthy: boolean; query?: () => Promise<unknown> }).query?.();
        }
        throw new Error('All databases unavailable');
      };

      await expect(query()).rejects.toThrow('All databases unavailable');
    });

    test('should handle security failures gracefully', async () => {
      /** Requête cliente avec indicateurs de suspension et de rate limiting. */
      interface SecurityRequest {
        userId: string;
        suspicious?: boolean;
        rateLimited?: boolean;
      }

      const securityCheck = {
        validate: async (request: SecurityRequest): Promise<true> => {
          if (request.suspicious) throw new Error('Suspicious activity detected');
          if (request.rateLimited) throw new Error('Rate limit exceeded');
          return true;
        }
      };

      /**
       * Execute an operation with security validation and structured error handling.
       *
       * Args:
       *     request: Incoming request with security flags.
       *     operation: Async operation to run if security passes.
       *
       * Returns:
       *     Operation result or structured error response.
       */
      const safeExecute = async (
        request: SecurityRequest,
        operation: () => Promise<SafeExecuteResult>
      ): Promise<SafeExecuteResult> => {
        try {
          await securityCheck.validate(request);
          return await operation();
        } catch (error) {
          const message = (error as Error).message;
          if (message.includes('Rate limit'))  return { error: 'RATE_LIMITED', retry: true };
          if (message.includes('Suspicious'))  return { error: 'BLOCKED', retry: false };
          return { error: 'UNKNOWN', retry: true };
        }
      };

      const normalResult = await safeExecute({ userId: 'user123' }, async () => ({ data: 'success' }));
      expect(normalResult.data).toBe('success');

      const rateLimitedResult = await safeExecute({ userId: 'user123', rateLimited: true }, async () => ({}));
      expect(rateLimitedResult.error).toBe('RATE_LIMITED');
      expect(rateLimitedResult.retry).toBe(true);

      const suspiciousResult = await safeExecute({ userId: 'user123', suspicious: true }, async () => ({}));
      expect(suspiciousResult.error).toBe('BLOCKED');
      expect(suspiciousResult.retry).toBe(false);
    });

    test('should propagate structured error codes through the pipeline', async () => {
      /**
       * Format an application error for API response serialization.
       *
       * Args:
       *     err: Application error with optional code and retryable flag.
       *
       * Returns:
       *     Formatted error object with message, code, and retryable fields.
       */
      const formatError = (err: AppError): FormattedError => ({
        message: err.message,
        code: err.code ?? 'INTERNAL_SERVER_ERROR',
        retryable: err.retryable ?? false
      });

      const dbError = Object.assign(new Error('Pool exhausted'), { code: 'DB_POOL_EXHAUSTED', retryable: true }) as AppError;
      const authError = Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN', retryable: false }) as AppError;

      expect(formatError(dbError)).toEqual({ message: 'Pool exhausted', code: 'DB_POOL_EXHAUSTED', retryable: true });
      expect(formatError(authError)).toEqual({ message: 'Forbidden', code: 'FORBIDDEN', retryable: false });
      expect(formatError(new Error('Unexpected') as AppError)).toEqual({ message: 'Unexpected', code: 'INTERNAL_SERVER_ERROR', retryable: false });
    });
  });

  // ─── Configuration Management ──────────────────────────────────────────────────

  describe('Configuration Management', () => {
    test('should support environment-specific overrides', () => {
      const baseConfig: AppConfig = {
        database: { host: 'localhost', port: 5432 },
        cache: { ttl: 300_000 },
        security: { enabled: true }
      };

      const environmentOverrides: Record<string, Partial<AppConfig>> = {
        development: {
          database: { host: 'dev.db.local' },
          security: { enabled: false }
        },
        production: {
          database: { host: 'prod.db.company.com', ssl: true },
          cache: { ttl: 600_000 }
        },
        test: {
          database: { host: 'memory' },
          cache: { ttl: 1000 },
          security: { enabled: false }
        }
      };

      /**
       * Merge base configuration with environment-specific overrides.
       *
       * Args:
       *     base: Base application configuration.
       *     env: Target environment name.
       *
       * Returns:
       *     Merged configuration with shallow override per section.
       */
      const mergeConfig = (base: AppConfig, env: string): AppConfig => {
        const result: AppConfig = JSON.parse(JSON.stringify(base));
        const override = environmentOverrides[env];

        if (override) {
          for (const [key, value] of Object.entries(override) as [keyof AppConfig, unknown][]) {
            if (typeof value === 'object' && !Array.isArray(value)) {
              result[key] = { ...(result[key] as object), ...(value as object) } as AppConfig[typeof key];
            } else {
              result[key] = value as AppConfig[typeof key];
            }
          }
        }

        return result;
      };

      const devConfig = mergeConfig(baseConfig, 'development');
      expect(devConfig.database.host).toBe('dev.db.local');
      expect(devConfig.database.port).toBe(5432); // Préservé depuis la base
      expect(devConfig.security.enabled).toBe(false);

      const prodConfig = mergeConfig(baseConfig, 'production');
      expect(prodConfig.database.host).toBe('prod.db.company.com');
      expect(prodConfig.database.ssl).toBe(true);
      expect(prodConfig.cache.ttl).toBe(600_000);

      const testConfig = mergeConfig(baseConfig, 'test');
      expect(testConfig.database.host).toBe('memory');
      expect(testConfig.cache.ttl).toBe(1000);
      expect(testConfig.security.enabled).toBe(false);
    });

    test('should resolve environment variable substitutions', () => {
      /**
       * Resolve ${VAR:-default} placeholders in a string value.
       *
       * Args:
       *     value: String potentially containing ${VAR:-default} patterns.
       *     env: Environment variable map used for substitution.
       *
       * Returns:
       *     Resolved string, or original value unchanged if not a string.
       */
      const resolveEnvVars = (value: unknown, env: Record<string, string> = {}): unknown => {
        if (typeof value !== 'string') return value;

        return value.replace(/\$\{([^}:-]+)(?::-(.*?))?\}/g, (_match, varName: string, defaultValue: string | undefined) => {
          const envValue = env[varName];
          if (envValue !== undefined && envValue !== '') return envValue;
          return defaultValue ?? '';
        });
      };

      const env: Record<string, string> = { DB_HOST: 'prod.db.com', PORT: '4000' };

      expect(resolveEnvVars('${DB_HOST:-localhost}', env)).toBe('prod.db.com');
      expect(resolveEnvVars('${MISSING_VAR:-default_value}', env)).toBe('default_value');
      expect(resolveEnvVars('${PORT:-3000}', env)).toBe('4000');
      expect(resolveEnvVars('${EMPTY:-fallback}', {})).toBe('fallback');
      expect(resolveEnvVars(42, env)).toBe(42); // Non-strings passés sans modification
    });

    test('should deep merge nested configuration sections', () => {
      /**
       * Recursively merge two plain objects, with override taking precedence.
       *
       * Args:
       *     base: Base object to merge into.
       *     override: Values to apply on top of base.
       *
       * Returns:
       *     New merged object (does not mutate inputs).
       */
      const deepMerge = (base: DeepRecord, override: DeepRecord): DeepRecord => {
        const result: DeepRecord = { ...base };
        for (const [key, value] of Object.entries(override)) {
          if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            typeof result[key] === 'object'
          ) {
            result[key] = deepMerge(result[key] as DeepRecord, value as DeepRecord);
          } else {
            result[key] = value;
          }
        }
        return result;
      };

      const base: DeepRecord    = { a: { b: { c: 1, d: 2 }, e: 3 }, f: 4 };
      const override: DeepRecord = { a: { b: { c: 99 } }, g: 5 };

      const merged = deepMerge(base, override);
      expect((merged.a as DeepRecord & { b: { c: number; d: number }; e: number }).b.c).toBe(99);  // Écrasé par override
      expect((merged.a as DeepRecord & { b: { c: number; d: number }; e: number }).b.d).toBe(2);   // Préservé depuis base
      expect((merged.a as DeepRecord & { b: { c: number; d: number }; e: number }).e).toBe(3);     // Préservé depuis base
      expect(merged.f).toBe(4);  // Préservé depuis base
      expect(merged.g).toBe(5);  // Ajouté depuis override
    });
  });
});
