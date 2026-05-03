// Comprehensive integration test suite — validates cross-component interactions
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { createTestContainer } from '../setup/di-container.js';

describe('Comprehensive API Integration Tests', () => {
  let container;

  beforeEach(() => {
    container = createTestContainer();
  });

  // ─── Dependency Injection Container ─────────────────────────────────────────

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

      const instance1 = container.get('counter');
      const instance2 = container.get('counter');

      expect(instance1).toBe(instance2);
      expect(instance1.count).toBe(1);
    });

    test('should resolve dependencies', () => {
      container.register('config', () => ({ api: { port: 3000 } }));
      container.register('logger', () => ({ log: jest.fn() }));
      container.register('server', (config, logger) => {
        return { config, logger, start: jest.fn() };
      }, { dependencies: ['config', 'logger'] });

      const server = container.get('server');

      expect(server.config.api.port).toBe(3000);
      expect(server.logger.log).toBeDefined();
    });

    test('should support mocking for tests', () => {
      const realService = { real: true };
      const mockService = { real: false, mock: true };

      container.register('service', () => realService);
      expect(container.get('service').real).toBe(true);

      container.mock('service', mockService);
      expect(container.get('service').real).toBe(false);
      expect(container.get('service').mock).toBe(true);

      container.unmock('service');
      expect(container.get('service').real).toBe(true);
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

  // ─── Multi-Database Architecture ─────────────────────────────────────────────

  describe('Multi-Database Architecture Tests', () => {
    test('should support multiple database configurations', () => {
      const createDatabaseConfig = (catalogs) => ({
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
        main: { PATH: 'data/main.ducklake', DATA_PATH: 'data/main_data/', READ_ONLY: true },
        analytics: { PATH: 'data/analytics.ducklake', DATA_PATH: 'data/analytics_data/', READ_ONLY: true },
        archive: { PATH: 'data/archive.ducklake', DATA_PATH: 'data/archive_data/', READ_ONLY: true }
      });

      expect(config.DATABASE_ROUTING.ALLOWED_DATABASES).toHaveLength(3);
      expect(config.CATALOGS).toHaveProperty('main');
      expect(config.CATALOGS).toHaveProperty('analytics');
      expect(config.CATALOGS).toHaveProperty('archive');
      expect(config.DATABASE.POOL.MAX_CONNECTIONS).toBe(10);
    });

    test('should route queries to correct databases', () => {
      const allowedDatabases = ['main', 'analytics', 'archive'];

      const queryRouter = {
        route: (query, databaseHint, userDatabase, defaultDatabase) => {
          const targetDb = query.database || databaseHint || userDatabase || defaultDatabase;

          if (!allowedDatabases.includes(targetDb)) {
            throw new Error(`Invalid database: ${targetDb}`);
          }

          return { ...query, targetDatabase: targetDb };
        }
      };

      const baseQuery = { operation: 'SELECT', table: 'facts' };

      expect(queryRouter.route(baseQuery, null, null, 'main').targetDatabase).toBe('main');
      expect(queryRouter.route(baseQuery, 'analytics', null, 'main').targetDatabase).toBe('analytics');
      expect(queryRouter.route({ ...baseQuery, database: 'archive' }, 'analytics', null, 'main').targetDatabase).toBe('archive');

      expect(() => queryRouter.route(baseQuery, 'invalid', null, 'main')).toThrow('Invalid database: invalid');
    });

    test('should prevent cross-database queries when disabled', () => {
      const config = { ALLOW_CROSS_DATABASE_QUERIES: false, DEFAULT_DATABASE: 'main' };

      const validateCrossDbQuery = (query, config) => {
        if (!config.ALLOW_CROSS_DATABASE_QUERIES && query.databases && query.databases.length > 1) {
          throw new Error('Cross-database queries are disabled');
        }
        return true;
      };

      expect(() => validateCrossDbQuery({ databases: ['main', 'analytics'] }, config))
        .toThrow('Cross-database queries are disabled');
      expect(validateCrossDbQuery({ databases: ['main'] }, config)).toBe(true);
    });
  });

  // ─── Security Pipeline Integration ───────────────────────────────────────────

  describe('Security Pipeline Integration', () => {
    test('should integrate all security components', async () => {
      const rateLimiter = {
        check: async (_clientId, _limit = 100) => true
      };

      const complexityAnalyzer = {
        analyze: (query) => {
          const baseComplexity = query.fields ? query.fields.length : 1;
          const depthMultiplier = query.depth || 1;
          return baseComplexity * depthMultiplier;
        }
      };

      const inputSanitizer = {
        sanitize: (input) => {
          if (typeof input === 'string') {
            return input
              .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
              .replace(/javascript:/gi, '');
          }
          return input;
        }
      };

      const securityPipeline = async (request, query, variables) => {
        const rateLimitPassed = await rateLimiter.check(request.clientId);
        if (!rateLimitPassed) throw new Error('Rate limit exceeded');

        const complexity = complexityAnalyzer.analyze(query);
        if (complexity > 1000) throw new Error('Query too complex');

        const sanitizedVariables = {};
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
      expect(result.complexity).toBe(4); // 2 fields * 2 depth
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
        analyze: (query) => query.fields.length * (query.depth || 1)
      };

      const pipeline = async (query) => {
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
      const sanitize = (value) => {
        if (typeof value === 'string') {
          return value.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').trim();
        }
        if (Array.isArray(value)) return value.map(sanitize);
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
        }
        return value;
      };

      expect(sanitize('<b>bold</b>')).toBe('bold');
      expect(sanitize(['<i>a</i>', 'clean'])).toEqual(['a', 'clean']);
      expect(sanitize({ label: '<em>tag</em>', count: 42 })).toEqual({ label: 'tag', count: 42 });
      expect(sanitize(42)).toBe(42);
    });
  });

  // ─── Caching Strategy ────────────────────────────────────────────────────────

  describe('Caching Strategy Tests', () => {
    test('should implement multi-level caching', async () => {
      const cache = new Map();

      const cacheManager = {
        generateKey: (prefix, database, params) =>
          `${prefix}:${database}:${JSON.stringify(params)}`,

        get: async (key) => cache.get(key),

        set: async (key, value, ttl = 300000) => {
          cache.set(key, { value, expires: Date.now() + ttl });
          return true;
        },

        // Accepts glob-style patterns: 'prefix:db:*'
        invalidatePattern: async (pattern) => {
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

      // Use glob-style pattern: 'metadata:main:*' → converted to regex 'metadata:main:.*'
      const invalidated = await cacheManager.invalidatePattern('metadata:main:*');
      expect(invalidated).toBe(2);
      expect(cache.size).toBe(1); // Only the 'facts' key should remain
    });

    test('should handle cache invalidation per database', async () => {
      const multiDbCache = new Map();

      const cacheKeys = [
        'metadata:main:field1',
        'metadata:test:field1',
        'facts:main:query1',
        'facts:test:query1',
        'dimension:main:country',
        'dimension:analytics:country'
      ];

      cacheKeys.forEach(key => multiDbCache.set(key, `value-${key}`));
      expect(multiDbCache.size).toBe(6);

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
      const cache = new Map();

      const cacheManager = {
        set: (key, value, ttl) => cache.set(key, { value, expires: Date.now() + ttl }),
        get: (key) => {
          const entry = cache.get(key);
          if (!entry) return null;
          if (Date.now() > entry.expires) {
            cache.delete(key);
            return null;
          }
          return entry.value;
        }
      };

      // Entry with TTL already elapsed
      cacheManager.set('expired-key', { data: 'stale' }, -1000);
      expect(cacheManager.get('expired-key')).toBeNull();
      expect(cache.has('expired-key')).toBe(false); // Evicted on access

      // Entry with valid TTL
      cacheManager.set('fresh-key', { data: 'fresh' }, 60000);
      expect(cacheManager.get('fresh-key')).toEqual({ data: 'fresh' });
    });

    test('should fall back to loader on cache miss', async () => {
      const cache = new Map();
      const dbLoader = jest.fn().mockResolvedValue([{ id: 1, name: 'France' }]);

      const withCache = async (key, loaderFn, ttl = 300000) => {
        if (cache.has(key)) return cache.get(key);
        const result = await loaderFn();
        cache.set(key, result);
        return result;
      };

      const result1 = await withCache('dimensions:main:country', dbLoader, 300000);
      const result2 = await withCache('dimensions:main:country', dbLoader, 300000);

      expect(dbLoader).toHaveBeenCalledTimes(1); // Second call served from cache
      expect(result1).toBe(result2); // Same reference from cache
    });
  });

  // ─── Data Loader Integration ──────────────────────────────────────────────────

  describe('Data Loader Integration', () => {
    test('should batch and cache data loading', async () => {
      const mockDatabase = {
        metadata: new Map([
          ['field1', { name: 'field1', type: 'string' }],
          ['field2', { name: 'field2', type: 'number' }],
          ['field3', { name: 'field3', type: 'boolean' }]
        ])
      };

      const createDataLoader = (batchLoadFn) => {
        const cache = new Map();
        let batchQueue = [];
        let batchTimer = null;

        const load = async (key) => {
          if (cache.has(key)) return cache.get(key);

          return new Promise((resolve) => {
            batchQueue.push({ key, resolve });

            if (!batchTimer) {
              batchTimer = setTimeout(async () => {
                const currentBatch = [...batchQueue];
                batchQueue = [];
                batchTimer = null;

                const keys = currentBatch.map(item => item.key);
                const results = await batchLoadFn(keys);

                currentBatch.forEach((item, index) => {
                  cache.set(item.key, results[index]);
                  item.resolve(results[index]);
                });
              }, 10);
            }
          });
        };

        return { load, cache };
      };

      const metadataLoader = createDataLoader(async (keys) =>
        keys.map(key => mockDatabase.metadata.get(key))
      );

      const results = await Promise.all([
        metadataLoader.load('field1'),
        metadataLoader.load('field2'),
        metadataLoader.load('field1') // cache hit
      ]);

      expect(results[0].name).toBe('field1');
      expect(results[1].name).toBe('field2');
      expect(results[2]).toBe(results[0]); // same reference from cache
      expect(metadataLoader.cache.size).toBe(2);
    });

    test('should deduplicate concurrent requests for the same key', async () => {
      let fetchCount = 0;
      const slowFetch = jest.fn(async () => {
        fetchCount++;
        return { value: 'result' };
      });

      const inFlightRequests = new Map();

      const deduplicatedFetch = async (key) => {
        if (inFlightRequests.has(key)) return inFlightRequests.get(key);
        const promise = slowFetch(key);
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

  // ─── Resolver + DataLoader Pipeline ──────────────────────────────────────────

  describe('Resolver and DataLoader Pipeline Integration', () => {
    test('should resolve fields using DataLoader across multiple resolvers', async () => {
      const batchLoadFn = jest.fn(async (keys) =>
        keys.map(id => ({ id, name: `Country-${id}`, code: id.toUpperCase() }))
      );

      const loaderCache = new Map();
      const inFlight = new Map();
      const dimensionLoader = {
        load: (id) => {
          if (loaderCache.has(id)) return Promise.resolve(loaderCache.get(id));
          if (inFlight.has(id)) return inFlight.get(id);

          const promise = batchLoadFn([id]).then(([result]) => {
            loaderCache.set(id, result);
            inFlight.delete(id);
            return result;
          });
          inFlight.set(id, promise);
          return promise;
        }
      };

      // Simulate multiple resolvers for different fact rows, each needing the same dimension
      const factRows = [
        { id: 1, countryId: 'fr', value: 100 },
        { id: 2, countryId: 'de', value: 200 },
        { id: 3, countryId: 'fr', value: 300 } // same as row 1 → cache hit
      ];

      const resolved = await Promise.all(
        factRows.map(async (row) => ({
          ...row,
          country: await dimensionLoader.load(row.countryId)
        }))
      );

      expect(resolved[0].country.name).toBe('Country-fr');
      expect(resolved[2].country).toBe(resolved[0].country); // Same object from cache
      expect(loaderCache.size).toBe(2); // 'fr' and 'de' only
    });

    test('should propagate database context from request to loader', async () => {
      const createLoaderWithContext = (databaseId) => ({
        databaseId,
        load: jest.fn(async (key) => ({ key, source: databaseId }))
      });

      const createContext = (databaseHint, availableDatabases, defaultDatabase) => {
        const targetDb = availableDatabases.includes(databaseHint) ? databaseHint : defaultDatabase;
        return {
          databaseId: targetDb,
          loaders: {
            metadata: createLoaderWithContext(targetDb),
            dimensions: createLoaderWithContext(targetDb)
          }
        };
      };

      const ctxMain = createContext('main', ['main', 'analytics'], 'main');
      const ctxAnalytics = createContext('analytics', ['main', 'analytics'], 'main');
      const ctxInvalid = createContext('unknown', ['main', 'analytics'], 'main');

      expect(ctxMain.databaseId).toBe('main');
      expect(ctxAnalytics.databaseId).toBe('analytics');
      expect(ctxInvalid.databaseId).toBe('main'); // Falls back to default

      const result = await ctxAnalytics.loaders.metadata.load('field1');
      expect(result.source).toBe('analytics');
    });
  });

  // ─── Full Request Lifecycle ───────────────────────────────────────────────────

  describe('Full Request Lifecycle Integration', () => {
    const buildRequestPipeline = () => {
      const securityLog = [];
      const resolverLog = [];

      const security = {
        validateRequest: async (request) => {
          if (request.body?.operationType === 'mutation') {
            throw new Error('Mutations are not allowed');
          }
          if (!request.body?.query) {
            throw new Error('Missing query');
          }
          securityLog.push({ event: 'validated', query: request.body.query });
        }
      };

      const resolver = async (query, context) => {
        const data = context.database.query(query);
        resolverLog.push({ event: 'resolved', rows: data.length });
        return data;
      };

      const formatResponse = (data, errors = []) => ({
        data: errors.length === 0 ? data : null,
        errors: errors.length > 0 ? errors.map(e => ({ message: e.message })) : undefined
      });

      const handleRequest = async (request, context) => {
        const errors = [];
        try {
          await security.validateRequest(request);
          const data = await resolver(request.body.query, context);
          return formatResponse(data);
        } catch (err) {
          errors.push(err);
          return formatResponse(null, errors);
        }
      };

      return { handleRequest, securityLog, resolverLog };
    };

    test('should process a valid query through the full pipeline', async () => {
      const { handleRequest, securityLog, resolverLog } = buildRequestPipeline();

      const context = {
        database: { query: (_q) => [{ id: 1, value: 100 }, { id: 2, value: 200 }] }
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
      expect(response.errors[0].message).toContain('not allowed');
      expect(resolverLog).toHaveLength(0); // Resolver never called
    });

    test('should reject requests with missing query body', async () => {
      const { handleRequest } = buildRequestPipeline();

      const response = await handleRequest({ body: {} }, {});

      expect(response.data).toBeNull();
      expect(response.errors[0].message).toContain('Missing query');
    });
  });

  // ─── Error Handling and Resilience ───────────────────────────────────────────

  describe('Error Handling and Resilience', () => {
    test('should handle database failover', async () => {
      const databasePools = {
        main: { healthy: false, error: 'Connection lost' },
        backup: { healthy: true, query: jest.fn().mockResolvedValue([{ id: 1 }]) },
        archive: { healthy: true, query: jest.fn().mockResolvedValue([]) }
      };

      const queryWithFailover = async (sql, preferredDb = 'main') => {
        const tryDatabases = [preferredDb, 'backup', 'archive'].filter(
          (db, index, arr) => arr.indexOf(db) === index
        );

        for (const dbName of tryDatabases) {
          const db = databasePools[dbName];
          if (db?.healthy) {
            try {
              return await db.query(sql);
            } catch {
              // Continue to next database
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
        main: { healthy: false },
        backup: { healthy: false }
      };

      const query = async () => {
        for (const db of Object.values(pools)) {
          if (db.healthy) return await db.query();
        }
        throw new Error('All databases unavailable');
      };

      await expect(query()).rejects.toThrow('All databases unavailable');
    });

    test('should handle security failures gracefully', async () => {
      const securityCheck = {
        validate: async (request) => {
          if (request.suspicious) throw new Error('Suspicious activity detected');
          if (request.rateLimited) throw new Error('Rate limit exceeded');
          return true;
        }
      };

      const safeExecute = async (request, operation) => {
        try {
          await securityCheck.validate(request);
          return await operation();
        } catch (error) {
          if (error.message.includes('Rate limit')) return { error: 'RATE_LIMITED', retry: true };
          if (error.message.includes('Suspicious')) return { error: 'BLOCKED', retry: false };
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
      const formatError = (err) => ({
        message: err.message,
        code: err.code || 'INTERNAL_SERVER_ERROR',
        retryable: err.retryable ?? false
      });

      const dbError = Object.assign(new Error('Pool exhausted'), { code: 'DB_POOL_EXHAUSTED', retryable: true });
      const authError = Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN', retryable: false });

      expect(formatError(dbError)).toEqual({ message: 'Pool exhausted', code: 'DB_POOL_EXHAUSTED', retryable: true });
      expect(formatError(authError)).toEqual({ message: 'Forbidden', code: 'FORBIDDEN', retryable: false });
      expect(formatError(new Error('Unexpected'))).toEqual({ message: 'Unexpected', code: 'INTERNAL_SERVER_ERROR', retryable: false });
    });
  });

  // ─── Configuration Management ─────────────────────────────────────────────────

  describe('Configuration Management', () => {
    test('should support environment-specific overrides', () => {
      const baseConfig = {
        database: { host: 'localhost', port: 5432 },
        cache: { ttl: 300000 },
        security: { enabled: true }
      };

      const environmentOverrides = {
        development: {
          database: { host: 'dev.db.local' },
          security: { enabled: false }
        },
        production: {
          database: { host: 'prod.db.company.com', ssl: true },
          cache: { ttl: 600000 }
        },
        test: {
          database: { host: 'memory' },
          cache: { ttl: 1000 },
          security: { enabled: false }
        }
      };

      const mergeConfig = (base, env) => {
        const result = JSON.parse(JSON.stringify(base));
        const override = environmentOverrides[env];

        if (override) {
          for (const [key, value] of Object.entries(override)) {
            if (typeof value === 'object' && !Array.isArray(value)) {
              result[key] = { ...result[key], ...value };
            } else {
              result[key] = value;
            }
          }
        }

        return result;
      };

      const devConfig = mergeConfig(baseConfig, 'development');
      expect(devConfig.database.host).toBe('dev.db.local');
      expect(devConfig.database.port).toBe(5432); // preserved from base
      expect(devConfig.security.enabled).toBe(false);

      const prodConfig = mergeConfig(baseConfig, 'production');
      expect(prodConfig.database.host).toBe('prod.db.company.com');
      expect(prodConfig.database.ssl).toBe(true);
      expect(prodConfig.cache.ttl).toBe(600000);

      const testConfig = mergeConfig(baseConfig, 'test');
      expect(testConfig.database.host).toBe('memory');
      expect(testConfig.cache.ttl).toBe(1000);
      expect(testConfig.security.enabled).toBe(false);
    });

    test('should resolve environment variable substitutions', () => {
      const resolveEnvVars = (value, env = {}) => {
        if (typeof value !== 'string') return value;

        return value.replace(/\$\{([^}:-]+)(?::-(.*?))?\}/g, (_match, varName, defaultValue) => {
          const envValue = env[varName];
          if (envValue !== undefined && envValue !== '') return envValue;
          return defaultValue ?? '';
        });
      };

      const env = { DB_HOST: 'prod.db.com', PORT: '4000' };

      expect(resolveEnvVars('${DB_HOST:-localhost}', env)).toBe('prod.db.com');
      expect(resolveEnvVars('${MISSING_VAR:-default_value}', env)).toBe('default_value');
      expect(resolveEnvVars('${PORT:-3000}', env)).toBe('4000');
      expect(resolveEnvVars('${EMPTY:-fallback}', {})).toBe('fallback');
      expect(resolveEnvVars(42, env)).toBe(42); // Non-strings are passed through unchanged
    });

    test('should deep merge nested configuration sections', () => {
      const deepMerge = (base, override) => {
        const result = { ...base };
        for (const [key, value] of Object.entries(override)) {
          if (value && typeof value === 'object' && !Array.isArray(value) && typeof result[key] === 'object') {
            result[key] = deepMerge(result[key], value);
          } else {
            result[key] = value;
          }
        }
        return result;
      };

      const base = { a: { b: { c: 1, d: 2 }, e: 3 }, f: 4 };
      const override = { a: { b: { c: 99 } }, g: 5 };

      const merged = deepMerge(base, override);
      expect(merged.a.b.c).toBe(99);  // overridden
      expect(merged.a.b.d).toBe(2);   // preserved from base
      expect(merged.a.e).toBe(3);     // preserved from base
      expect(merged.f).toBe(4);       // preserved from base
      expect(merged.g).toBe(5);       // added from override
    });
  });
});
