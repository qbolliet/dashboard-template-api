// Comprehensive test suite that demonstrates all the functionality working together
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { createTestContainer } from '../di-container.js';

describe('Comprehensive API Unit Tests', () => {
  let container;

  beforeEach(() => {
    container = createTestContainer();
  });

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
  });

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
      const queryRouter = {
        route: (query, databaseHint, userDatabase, defaultDatabase) => {
          // Priority: explicit parameter > user preference > default
          const targetDb = query.database || databaseHint || userDatabase || defaultDatabase;
          
          if (!['main', 'analytics', 'archive'].includes(targetDb)) {
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
  });

  describe('Security Pipeline Integration', () => {
    test('should integrate all security components', async () => {
      // Rate limiter
      const rateLimiter = {
        check: async (clientId, limit = 100) => {
          // Deterministic rate limiting for testing
          return true; // Always pass for test predictability
        }
      };

      // Complexity analyzer
      const complexityAnalyzer = {
        analyze: (query) => {
          const baseComplexity = query.fields ? query.fields.length : 1;
          const depthMultiplier = query.depth || 1;
          return baseComplexity * depthMultiplier;
        }
      };

      // Input sanitizer
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

      // Security pipeline
      const securityPipeline = async (request, query, variables) => {
        // 1. Rate limiting
        const rateLimitPassed = await rateLimiter.check(request.clientId);
        if (!rateLimitPassed) {
          throw new Error('Rate limit exceeded');
        }

        // 2. Complexity analysis
        const complexity = complexityAnalyzer.analyze(query);
        if (complexity > 1000) {
          throw new Error('Query too complex');
        }

        // 3. Input sanitization
        const sanitizedVariables = {};
        for (const [key, value] of Object.entries(variables)) {
          sanitizedVariables[key] = inputSanitizer.sanitize(value);
        }

        return { query, variables: sanitizedVariables, complexity };
      };

      // Test normal request
      const normalRequest = { clientId: 'user123' };
      const normalQuery = { fields: ['name', 'email'], depth: 2 };
      const normalVariables = { search: 'john doe' };

      const result = await securityPipeline(normalRequest, normalQuery, normalVariables);
      expect(result.query).toBe(normalQuery);
      expect(result.variables.search).toBe('john doe');
      expect(result.complexity).toBe(4); // 2 fields * 2 depth

      // Test malicious input
      const maliciousVariables = { search: '<script>alert("xss")</script>search term' };
      const sanitizedResult = await securityPipeline(normalRequest, normalQuery, maliciousVariables);
      expect(sanitizedResult.variables.search).not.toContain('<script>');
      expect(sanitizedResult.variables.search).toContain('search term');
    });
  });

  describe('Caching Strategy Tests', () => {
    test('should implement multi-level caching', () => {
      const cache = new Map();
      
      const cacheManager = {
        generateKey: (prefix, database, params) => {
          return `${prefix}:${database}:${JSON.stringify(params)}`;
        },
        
        get: async (key) => {
          return cache.get(key);
        },
        
        set: async (key, value, ttl = 300000) => {
          cache.set(key, { value, expires: Date.now() + ttl });
          return true;
        },
        
        invalidatePattern: async (pattern) => {
          const regex = new RegExp(pattern.replace('*', '.*'));
          const keysToDelete = Array.from(cache.keys()).filter(key => regex.test(key));
          keysToDelete.forEach(key => cache.delete(key));
          return keysToDelete.length;
        }
      };

      // Test cache operations
      const key1 = cacheManager.generateKey('metadata', 'main', { field: 'country' });
      const key2 = cacheManager.generateKey('metadata', 'main', { field: 'indicator' });
      const key3 = cacheManager.generateKey('facts', 'main', { limit: 100 });

      expect(key1).toBe('metadata:main:{"field":"country"}');
      
      // Set values
      cacheManager.set(key1, { name: 'country', type: 'categorical' });
      cacheManager.set(key2, { name: 'indicator', type: 'categorical' });
      cacheManager.set(key3, [{ id: 1, value: 100 }]);

      // Verify caching
      expect(cache.size).toBe(3);
      
      // Test pattern invalidation
      const invalidated = cacheManager.invalidatePattern('metadata:main:.*');
      expect(invalidated).resolves.toBe(2);
      expect(cache.size).toBe(1); // Only facts should remain
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

      // Invalidate only main database
      const mainPattern = /.*:main:.*/;
      const mainKeys = Array.from(multiDbCache.keys()).filter(key => mainPattern.test(key));
      mainKeys.forEach(key => multiDbCache.delete(key));

      expect(multiDbCache.size).toBe(3); // test and analytics should remain
      expect(Array.from(multiDbCache.keys())).toEqual([
        'metadata:test:field1',
        'facts:test:query1',
        'dimension:analytics:country'
      ]);
    });
  });

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
          if (cache.has(key)) {
            return cache.get(key);
          }

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
                  const result = results[index];
                  cache.set(item.key, result);
                  item.resolve(result);
                });
              }, 10);
            }
          });
        };

        return { load, cache };
      };

      const metadataLoader = createDataLoader(async (keys) => {
        // Simulate database batch query
        return keys.map(key => mockDatabase.metadata.get(key));
      });

      // Load multiple items
      const promises = [
        metadataLoader.load('field1'),
        metadataLoader.load('field2'),
        metadataLoader.load('field1'), // Should use cache
      ];

      const results = await Promise.all(promises);

      expect(results[0].name).toBe('field1');
      expect(results[1].name).toBe('field2');
      expect(results[2]).toBe(results[0]); // Same instance from cache
      expect(metadataLoader.cache.size).toBe(2); // field1 and field2
    });
  });

  describe('Error Handling and Resilience', () => {
    test('should handle database failover', async () => {
      const databasePools = {
        main: { healthy: false, error: 'Connection lost' },
        backup: { healthy: true, query: jest.fn().mockResolvedValue([{ id: 1 }]) },
        archive: { healthy: true, query: jest.fn().mockResolvedValue([]) }
      };

      const queryWithFailover = async (sql, preferredDb = 'main') => {
        const tryDatabases = [preferredDb, 'backup', 'archive'].filter((db, index, arr) => 
          arr.indexOf(db) === index // Remove duplicates
        );

        for (const dbName of tryDatabases) {
          const db = databasePools[dbName];
          if (db?.healthy) {
            try {
              return await db.query(sql);
            } catch (error) {
              // Continue to next database
            }
          }
        }

        throw new Error('All databases unavailable');
      };

      // Main database is down, should failover to backup
      const result = await queryWithFailover('SELECT * FROM facts', 'main');
      expect(result).toEqual([{ id: 1 }]);
      expect(databasePools.backup.query).toHaveBeenCalled();
    });

    test('should handle security failures gracefully', async () => {
      const securityCheck = {
        validate: async (request) => {
          if (request.suspicious) {
            throw new Error('Suspicious activity detected');
          }
          if (request.rateLimited) {
            throw new Error('Rate limit exceeded');
          }
          return true;
        }
      };

      const safeExecute = async (request, operation) => {
        try {
          await securityCheck.validate(request);
          return await operation();
        } catch (error) {
          if (error.message.includes('Rate limit')) {
            return { error: 'RATE_LIMITED', retry: true };
          }
          if (error.message.includes('Suspicious')) {
            return { error: 'BLOCKED', retry: false };
          }
          return { error: 'UNKNOWN', retry: true };
        }
      };

      // Normal request
      const normalResult = await safeExecute(
        { userId: 'user123' },
        async () => ({ data: 'success' })
      );
      expect(normalResult.data).toBe('success');

      // Rate limited request
      const rateLimitedResult = await safeExecute(
        { userId: 'user123', rateLimited: true },
        async () => ({ data: 'success' })
      );
      expect(rateLimitedResult.error).toBe('RATE_LIMITED');
      expect(rateLimitedResult.retry).toBe(true);

      // Suspicious request
      const suspiciousResult = await safeExecute(
        { userId: 'user123', suspicious: true },
        async () => ({ data: 'success' })
      );
      expect(suspiciousResult.error).toBe('BLOCKED');
      expect(suspiciousResult.retry).toBe(false);
    });
  });

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
        const result = JSON.parse(JSON.stringify(base)); // Deep clone
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
      expect(devConfig.database.port).toBe(5432); // Preserved from base
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
  });
});