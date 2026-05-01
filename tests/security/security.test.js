// Unit tests for security framework components
import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import {
  SecurityManager,
  RateLimiter,
  QueryComplexityAnalyzer,
  InputSanitizer,
  PatternValidator
} from '../../src/security/index.js';

// Mock dependencies
jest.mock('../../src/utils/config-loader.js', () => ({
  config: {
    SECURITY: {
      RATE_LIMIT: {
        MAX_REQUESTS: 100,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 20,
        BURST_WINDOW_MS: 60000,
        SKIP_FAILED_REQUESTS: false,
        TRUSTED_PROXIES: []
      },
      COMPLEXITY: {
        MAX_ALLOWED: 1000,
        SCALAR_COST: 0,
        OBJECT_COST: 1,
        LIST_FACTOR: 10,
        DEPTH_FACTOR: 2,
        INTROSPECTION_COST: 1000,
        CUSTOM_SCORES: {}
      },
      SANITIZATION: {
        ENABLE_XSS: true,
        ENABLE_SQL: true,
        MAX_STRING_LENGTH: 10000,
        ALLOWED_TAGS: [],
        CUSTOM_SANITIZERS: {}
      }
    },
    SECURITY_LIMITS: {
      COMPLEXITY_CALCULATION_FACTOR: 0.1
    },
    SECURITY_PATTERNS: {
      blocked: [],
      allowed: []
    },
    API: {
      SECURITY_THRESHOLDS: {
        QUERY_SNIPPET_LENGTH: 100
      }
    }
  }
}));

jest.mock('../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    security: jest.fn(),
    operation: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    database: jest.fn(),
    cache: jest.fn(),
    performance: jest.fn()
  })
}));

describe('SecurityManager', () => {
  let securityManager;
  let mockContext;
  let mockInfo;

  beforeEach(() => {
    jest.clearAllMocks();
    securityManager = new SecurityManager();

    mockContext = {
      requestId: 'test-request-id',
      req: {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'test-agent' }
      }
    };

    mockInfo = {
      fieldName: 'testField',
      fieldNodes: [{
        kind: 'Field',
        name: { value: 'testField' },
        arguments: [],
        selectionSet: null
      }],
      schema: null,
      fragments: {},
      variableValues: {}
    };
  });

  describe('Constructor', () => {
    test('should initialize with default configuration', () => {
      expect(securityManager.config).toBeDefined();
      expect(securityManager.rateLimiter).toBeInstanceOf(RateLimiter);
      expect(securityManager.complexityAnalyzer).toBeInstanceOf(QueryComplexityAnalyzer);
      expect(securityManager.inputSanitizer).toBeInstanceOf(InputSanitizer);
      expect(securityManager.patternValidator).toBeInstanceOf(PatternValidator);
    });

    test('should initialize with custom configuration', () => {
      const customConfig = {
        RATE_LIMIT: { MAX_REQUESTS: 5, WINDOW_MS: 60000, MAX_BURST_REQUESTS: 2, BURST_WINDOW_MS: 60000, TRUSTED_PROXIES: [] },
        COMPLEXITY: { MAX_ALLOWED: 500, LIST_FACTOR: 10, DEPTH_FACTOR: 2 },
        SANITIZATION: { MAX_STRING_LENGTH: 500 }
      };

      const customManager = new SecurityManager(customConfig);
      expect(customManager.config).toEqual(customConfig);
    });
  });

  describe('createSecurityMiddleware', () => {
    test('should create middleware function', () => {
      const middleware = securityManager.createSecurityMiddleware();
      expect(typeof middleware).toBe('function');
    });

    test('should execute security checks in correct order', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      const mockResolve = jest.fn().mockResolvedValue('test-result');

      securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue({ limit: 100, remaining: 99 });
      securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(100);
      securityManager.inputSanitizer.sanitizeAll = jest.fn().mockReturnValue({});

      const result = await middleware(mockResolve, null, {}, mockContext, mockInfo);

      expect(securityManager.rateLimiter.checkLimit).toHaveBeenCalled();
      expect(securityManager.complexityAnalyzer.calculate).toHaveBeenCalled();
      expect(securityManager.inputSanitizer.sanitizeAll).toHaveBeenCalled();
      expect(mockResolve).toHaveBeenCalled();
      expect(result).toBe('test-result');
    });

    test('should handle rate limit exceeded', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      const mockResolve = jest.fn();

      securityManager.rateLimiter.checkLimit = jest.fn().mockRejectedValue(
        new GraphQLError('Too many requests', { extensions: { code: 'RATE_LIMIT_EXCEEDED' } })
      );

      await expect(
        middleware(mockResolve, null, {}, mockContext, mockInfo)
      ).rejects.toThrow(GraphQLError);
    });

    test('should handle complexity limit exceeded', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      const mockResolve = jest.fn();

      securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue({ limit: 100, remaining: 99 });
      securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(2000);

      await expect(
        middleware(mockResolve, null, {}, mockContext, mockInfo)
      ).rejects.toThrow(GraphQLError);
    });
  });
});

describe('RateLimiter', () => {
  let rateLimiter;
  let mockReq;

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimiter = new RateLimiter({
      MAX_REQUESTS: 10,
      WINDOW_MS: 60000,
      MAX_BURST_REQUESTS: 5,
      BURST_WINDOW_MS: 60000,
      TRUSTED_PROXIES: []
    });

    mockReq = {
      ip: '192.168.1.1',
      headers: { 'user-agent': 'test-browser' }
    };
  });

  afterEach(async () => {
    await rateLimiter.stop();
  });

  describe('checkLimit', () => {
    test('should allow requests within limit', async () => {
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result).toBeDefined();
      expect(result.limit).toBe(10);
      expect(typeof result.remaining).toBe('number');
    });

    test('should generate consistent keys for same client', () => {
      const key1 = rateLimiter.defaultKeyGenerator(mockReq);
      const key2 = rateLimiter.defaultKeyGenerator(mockReq);
      expect(key1).toBe(key2);
    });

    test('should generate different keys for different IPs', () => {
      const req1 = { ip: '192.168.1.1', headers: { 'user-agent': 'browser' } };
      const req2 = { ip: '192.168.1.2', headers: { 'user-agent': 'browser' } };

      const key1 = rateLimiter.defaultKeyGenerator(req1);
      const key2 = rateLimiter.defaultKeyGenerator(req2);
      expect(key1).not.toBe(key2);
    });

    test('should handle missing IP gracefully', () => {
      const reqWithoutIP = { headers: { 'user-agent': 'test-browser' } };
      const key = rateLimiter.defaultKeyGenerator(reqWithoutIP);
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    test('should track request count correctly', async () => {
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }

      const key = rateLimiter.defaultKeyGenerator(mockReq);
      expect(rateLimiter.store.has(key)).toBe(true);
      const data = rateLimiter.store.get(key);
      expect(data.requests).toHaveLength(5);
    });
  });

  describe('cleanup', () => {
    test('should remove expired entries', () => {
      const key = 'test-key';
      rateLimiter.store.set(key, {
        requests: [Date.now() - 120000], // Expired (older than 60000ms window)
        burstCount: 0,
        lastBurstReset: Date.now() - 120000,
        violations: 0
      });

      rateLimiter._removeExpiredEntries();
      expect(rateLimiter.store.has(key)).toBe(false);
    });

    test('should keep valid entries', () => {
      const key = 'test-key';
      rateLimiter.store.set(key, {
        requests: [Date.now()], // Fresh
        burstCount: 0,
        lastBurstReset: Date.now(),
        violations: 0
      });

      rateLimiter._removeExpiredEntries();
      expect(rateLimiter.store.has(key)).toBe(true);
    });
  });
});

describe('QueryComplexityAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new QueryComplexityAnalyzer({
      MAX_ALLOWED: 1000,
      SCALAR_COST: 0,
      OBJECT_COST: 1,
      LIST_FACTOR: 10,
      DEPTH_FACTOR: 2,
      INTROSPECTION_COST: 100,
      CUSTOM_SCORES: {}
    });
  });

  describe('calculate', () => {
    test('should return 0 when fieldNodes is missing', () => {
      const complexity = analyzer.calculate({});
      expect(complexity).toBe(0);
    });

    test('should calculate complexity for simple query', () => {
      const mockInfo = {
        fieldNodes: [{
          kind: 'Field',
          name: { value: 'simpleField' },
          arguments: [],
          selectionSet: null
        }],
        schema: null,
        fragments: {},
        variableValues: {}
      };

      const complexity = analyzer.calculate(mockInfo);
      expect(complexity).toBeGreaterThanOrEqual(0);
    });

    test('should handle introspection queries', () => {
      const mockInfo = {
        fieldNodes: [{
          kind: 'Field',
          name: { value: '__schema' },
          arguments: [],
          selectionSet: {
            selections: [
              { kind: 'Field', name: { value: 'types' }, arguments: [], selectionSet: null }
            ]
          }
        }],
        schema: null,
        fragments: {},
        variableValues: {}
      };

      const complexity = analyzer.calculate(mockInfo);
      expect(complexity).toBeGreaterThanOrEqual(100); // introspection cost
    });

    test('should handle nested selections', () => {
      const mockInfo = {
        fieldNodes: [{
          kind: 'Field',
          name: { value: 'parentField' },
          arguments: [],
          selectionSet: {
            selections: [{
              kind: 'Field',
              name: { value: 'childField' },
              arguments: [],
              selectionSet: {
                selections: [{
                  kind: 'Field',
                  name: { value: 'grandchildField' },
                  arguments: [],
                  selectionSet: null
                }]
              }
            }]
          }
        }],
        schema: null,
        fragments: {},
        variableValues: {}
      };

      const complexity = analyzer.calculate(mockInfo);
      expect(complexity).toBeGreaterThan(0);
    });

    test('should handle queries with limit arguments', () => {
      const mockInfo = {
        fieldNodes: [{
          kind: 'Field',
          name: { value: 'fieldWithArgs' },
          arguments: [{
            name: { value: 'limit' },
            value: { kind: 'IntValue', value: '10' }
          }],
          selectionSet: null
        }],
        schema: null,
        fragments: {},
        variableValues: {}
      };

      const complexity = analyzer.calculate(mockInfo);
      expect(complexity).toBeGreaterThanOrEqual(0);
    });
  });

  describe('extractNumericValue', () => {
    test('should extract integer from IntValue node', () => {
      const value = analyzer.extractNumericValue({ kind: 'IntValue', value: '42' });
      expect(value).toBe(42);
    });

    test('should extract float from FloatValue node', () => {
      const value = analyzer.extractNumericValue({ kind: 'FloatValue', value: '3.14' });
      expect(value).toBeCloseTo(3.14);
    });

    test('should return 0 for non-numeric node kinds', () => {
      const value = analyzer.extractNumericValue({ kind: 'StringValue', value: 'invalid' });
      expect(value).toBe(0);
    });

    test('should return 0 for missing kind', () => {
      const value = analyzer.extractNumericValue({});
      expect(value).toBe(0);
    });
  });
});

describe('InputSanitizer', () => {
  let sanitizer;

  beforeEach(() => {
    sanitizer = new InputSanitizer({
      ENABLE_XSS: true,
      ENABLE_SQL: true,
      MAX_STRING_LENGTH: 100,
      ALLOWED_TAGS: [],
      CUSTOM_SANITIZERS: {}
    });
  });

  describe('sanitizeAll', () => {
    test('should sanitize object recursively', () => {
      const input = {
        field1: '<script>alert("xss")</script>Hello',
        nested: {
          field3: 'normal text'
        }
      };

      const result = sanitizer.sanitizeAll(input);
      expect(result.field1).not.toContain('<script>');
      expect(result.nested.field3).toBe('normal text');
    });

    test('should handle arrays', () => {
      const input = {
        items: ['<script>test</script>', 'normal']
      };

      const result = sanitizer.sanitizeAll(input);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items[0]).not.toContain('<script>');
      expect(result.items[1]).toBe('normal');
    });

    test('should handle primitive values', () => {
      expect(sanitizer.sanitizeAll(123)).toBe(123);
      expect(sanitizer.sanitizeAll(true)).toBe(true);
    });
  });

  describe('sanitizeXSS', () => {
    test('should remove script tags', () => {
      const input = '<script>alert("xss")</script>Hello';
      const result = sanitizer.sanitizeXSS(input);
      expect(result).not.toContain('<script>');
      expect(result).toContain('Hello');
    });

    test('should handle javascript: in href attributes', () => {
      const input = '<a href="javascript:alert(1)">click</a>';
      const result = sanitizer.sanitizeXSS(input);
      expect(result).not.toContain('javascript:');
    });

    test('should handle on* event handlers', () => {
      const input = '<img src="x" onerror="alert(1)">';
      const result = sanitizer.sanitizeXSS(input);
      expect(result).not.toContain('onerror');
    });
  });

  describe('sanitizeSQL', () => {
    test('should pass through safe strings unchanged', () => {
      const input = 'normal string value';
      const result = sanitizer.sanitizeSQL(input);
      expect(result).toBe(input);
    });

    test('should throw on SQL comment sequences', () => {
      expect(() => sanitizer.sanitizeSQL("'; DROP TABLE users; --")).toThrow(GraphQLError);
    });

    test('should throw on block comment sequences', () => {
      expect(() => sanitizer.sanitizeSQL('SELECT /* comment */ 1')).toThrow(GraphQLError);
    });
  });

  describe('sanitizeNumber', () => {
    test('should handle valid integers', () => {
      expect(sanitizer.sanitizeNumber(42, 'field')).toBe(42);
    });

    test('should handle valid floats', () => {
      expect(sanitizer.sanitizeNumber(3.14, 'field')).toBe(3.14);
    });

    test('should throw for NaN', () => {
      expect(() => sanitizer.sanitizeNumber(NaN, 'field')).toThrow(GraphQLError);
    });

    test('should throw for Infinity', () => {
      expect(() => sanitizer.sanitizeNumber(Infinity, 'field')).toThrow(GraphQLError);
      expect(() => sanitizer.sanitizeNumber(-Infinity, 'field')).toThrow(GraphQLError);
    });
  });
});

describe('PatternValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new PatternValidator();
  });

  describe('validateQuery', () => {
    test('should validate simple queries without throwing', async () => {
      await expect(validator.validateQuery('query { user { name } }')).resolves.toBeUndefined();
    });

    test('should handle complex queries without throwing', async () => {
      const query = `
        query GetUserData($id: ID!) {
          user(id: $id) {
            name
            posts { title }
          }
        }
      `;
      await expect(validator.validateQuery(query)).resolves.toBeUndefined();
    });

    test('should handle malformed queries gracefully', async () => {
      await expect(validator.validateQuery('invalid query syntax {{{')).resolves.toBeUndefined();
    });

    test('should handle null/undefined input gracefully', async () => {
      await expect(validator.validateQuery(null)).resolves.toBeUndefined();
      await expect(validator.validateQuery(undefined)).resolves.toBeUndefined();
    });
  });

  describe('pattern compilation', () => {
    test('should compile patterns without throwing', () => {
      expect(() => {
        validator.compilePatterns();
      }).not.toThrow();
    });

    test('should reload patterns without throwing', () => {
      expect(() => {
        validator.reload();
      }).not.toThrow();
    });
  });
});

describe('Security Integration Tests', () => {
  test('should work together in realistic scenarios', async () => {
    const securityManager = new SecurityManager();
    const middleware = securityManager.createSecurityMiddleware();

    const mockResolve = jest.fn().mockResolvedValue('result');
    const mockContext = {
      requestId: 'integration-test',
      req: { ip: '127.0.0.1', headers: { 'user-agent': 'test' } }
    };
    const mockInfo = {
      fieldName: 'testQuery',
      fieldNodes: [{
        kind: 'Field',
        name: { value: 'simpleField' },
        arguments: [],
        selectionSet: null
      }],
      schema: null,
      fragments: {},
      variableValues: {}
    };
    const mockArgs = { input: 'clean input' };

    securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue({ limit: 100, remaining: 99 });
    securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(50);
    securityManager.inputSanitizer.sanitizeAll = jest.fn().mockReturnValue(mockArgs);
    securityManager.patternValidator.validateQuery = jest.fn().mockResolvedValue(undefined);

    const result = await middleware(mockResolve, null, mockArgs, mockContext, mockInfo);
    expect(result).toBe('result');
  });

  test('should handle multiple security violations — rate limit checked first', async () => {
    const securityManager = new SecurityManager();
    const middleware = securityManager.createSecurityMiddleware();

    const mockResolve = jest.fn();
    const mockContext = {
      requestId: 'violation-test',
      req: { ip: '127.0.0.1', headers: { 'user-agent': 'test' } }
    };
    const mockInfo = {
      fieldName: 'testQuery',
      fieldNodes: [{ kind: 'Field', name: { value: 'simpleField' }, arguments: [], selectionSet: null }],
      schema: null,
      fragments: {},
      variableValues: {}
    };

    securityManager.rateLimiter.checkLimit = jest.fn().mockRejectedValue(
      new GraphQLError('Too many requests', { extensions: { code: 'RATE_LIMIT_EXCEEDED' } })
    );
    securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(2000);

    await expect(
      middleware(mockResolve, null, {}, mockContext, mockInfo)
    ).rejects.toThrow('Too many requests');
  });
});
