// Unit tests for src/security/manager.js
import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Mock config ──────────────────────────────────────────────────────────────

const mockConfig = {
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
      INTROSPECTION_COST: 100,
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
};

// ─── Mock registration ────────────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
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

// ─── Dynamic imports ──────────────────────────────────────────────────────────

let SecurityManager, RateLimiter, QueryComplexityAnalyzer, InputSanitizer, PatternValidator;

beforeAll(async () => {
  ({
    SecurityManager,
    RateLimiter,
    QueryComplexityAnalyzer,
    InputSanitizer,
    PatternValidator
  } = await import('../../../src/security/index.js'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SecurityManager', () => {
  let securityManager;

  const mockContext = {
    requestId: 'test-request-id',
    req: { ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } }
  };

  const mockInfo = {
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

  beforeEach(() => {
    jest.clearAllMocks();
    securityManager = new SecurityManager();
  });

  afterEach(async () => {
    await securityManager.cleanup();
  });

  describe('Constructor', () => {
    test('initializes with default config from config-loader', () => {
      expect(securityManager.config).toEqual(mockConfig.SECURITY);
    });

    test('initializes with custom config when provided', () => {
      const customConfig = {
        RATE_LIMIT: { MAX_REQUESTS: 5, WINDOW_MS: 60000, MAX_BURST_REQUESTS: 2, BURST_WINDOW_MS: 60000, TRUSTED_PROXIES: [] },
        COMPLEXITY: { MAX_ALLOWED: 500, SCALAR_COST: 0, OBJECT_COST: 1, LIST_FACTOR: 10, DEPTH_FACTOR: 2, INTROSPECTION_COST: 100, CUSTOM_SCORES: {} },
        SANITIZATION: { ENABLE_XSS: true, ENABLE_SQL: true, MAX_STRING_LENGTH: 500, ALLOWED_TAGS: [], CUSTOM_SANITIZERS: {} }
      };
      const custom = new SecurityManager(customConfig);
      expect(custom.config).toEqual(customConfig);
      custom.cleanup();
    });

    test('creates sub-modules of the correct classes', () => {
      expect(securityManager.rateLimiter).toBeInstanceOf(RateLimiter);
      expect(securityManager.complexityAnalyzer).toBeInstanceOf(QueryComplexityAnalyzer);
      expect(securityManager.inputSanitizer).toBeInstanceOf(InputSanitizer);
      expect(securityManager.patternValidator).toBeInstanceOf(PatternValidator);
    });
  });

  describe('createSecurityMiddleware', () => {
    test('returns a function', () => {
      expect(typeof securityManager.createSecurityMiddleware()).toBe('function');
    });

    test('runs security checks then calls resolver and returns its result', async () => {
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

    test('propagates rate-limit error', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      securityManager.rateLimiter.checkLimit = jest.fn().mockRejectedValue(
        new GraphQLError('Too many requests', { extensions: { code: 'RATE_LIMIT_EXCEEDED' } })
      );

      await expect(
        middleware(jest.fn(), null, {}, mockContext, mockInfo)
      ).rejects.toThrow(GraphQLError);
    });

    test('throws when complexity exceeds MAX_ALLOWED', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue({ limit: 100, remaining: 99 });
      securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(2000);

      await expect(
        middleware(jest.fn(), null, {}, mockContext, mockInfo)
      ).rejects.toThrow(GraphQLError);
    });

    test('skips rate-limit check when req is absent', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      const noReqContext = { requestId: 'no-req' };
      securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue({});
      securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(0);
      securityManager.inputSanitizer.sanitizeAll = jest.fn().mockReturnValue({});

      await middleware(jest.fn().mockResolvedValue('ok'), null, {}, noReqContext, mockInfo);
      expect(securityManager.rateLimiter.checkLimit).not.toHaveBeenCalled();
    });
  });

  describe('validateRequest', () => {
    test('passes for a normal query', async () => {
      const operation = { operation: 'query', name: { value: 'MyQuery' } };
      const request = { query: 'query { test }' };
      await expect(securityManager.validateRequest(operation, request, mockContext)).resolves.toBeUndefined();
    });

    test('throws for mutation operations', async () => {
      const operation = { operation: 'mutation', name: { value: 'MyMutation' } };
      const request = {};
      await expect(securityManager.validateRequest(operation, request, mockContext))
        .rejects.toThrow(GraphQLError);
    });

    test('throws for subscription operations', async () => {
      const operation = { operation: 'subscription', name: { value: 'MySub' } };
      const request = {};
      await expect(securityManager.validateRequest(operation, request, mockContext))
        .rejects.toThrow(GraphQLError);
    });

    test('calls patternValidator when request.query is present', async () => {
      securityManager.patternValidator.validateQuery = jest.fn().mockResolvedValue(undefined);
      const operation = { operation: 'query' };
      const request = { query: 'query { test }' };
      await securityManager.validateRequest(operation, request, mockContext);
      expect(securityManager.patternValidator.validateQuery).toHaveBeenCalledWith('query { test }');
    });
  });

  describe('shouldSkipRateLimit', () => {
    test('returns false for regular fields', () => {
      expect(securityManager.shouldSkipRateLimit({ fieldName: 'facts' })).toBe(false);
    });

    test('returns true for __schema in non-production', () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      expect(securityManager.shouldSkipRateLimit({ fieldName: '__schema' })).toBe(true);
      process.env.NODE_ENV = original;
    });
  });

  describe('isOperationAllowed', () => {
    test('returns true for arbitrary operation names by default', () => {
      expect(securityManager.isOperationAllowed('AnyOperation')).toBe(true);
    });

    test('returns true for IntrospectionQuery in non-production', () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      expect(securityManager.isOperationAllowed('IntrospectionQuery')).toBe(true);
      process.env.NODE_ENV = original;
    });
  });
});

// ─── Integration ──────────────────────────────────────────────────────────────

describe('Security integration', () => {
  let securityManager;

  afterEach(async () => {
    if (securityManager) await securityManager.cleanup();
  });

  test('middleware passes clean request end-to-end', async () => {
    securityManager = new SecurityManager();
    const middleware = securityManager.createSecurityMiddleware();
    const mockResolve = jest.fn().mockResolvedValue('result');
    const ctx = { requestId: 'int-test', req: { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } };
    const info = {
      fieldName: 'testQuery',
      fieldNodes: [{ kind: 'Field', name: { value: 'simpleField' }, arguments: [], selectionSet: null }],
      schema: null, fragments: {}, variableValues: {}
    };

    securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue({ limit: 100, remaining: 99 });
    securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(50);
    securityManager.inputSanitizer.sanitizeAll = jest.fn().mockReturnValue({ input: 'clean' });

    const result = await middleware(mockResolve, null, { input: 'clean' }, ctx, info);
    expect(result).toBe('result');
  });

  test('rate-limit violation is reported before complexity check', async () => {
    securityManager = new SecurityManager();
    const middleware = securityManager.createSecurityMiddleware();
    const ctx = { requestId: 'viol-test', req: { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } };
    const info = {
      fieldName: 'testQuery',
      fieldNodes: [{ kind: 'Field', name: { value: 'simpleField' }, arguments: [], selectionSet: null }],
      schema: null, fragments: {}, variableValues: {}
    };

    securityManager.rateLimiter.checkLimit = jest.fn().mockRejectedValue(
      new GraphQLError('Too many requests', { extensions: { code: 'RATE_LIMIT_EXCEEDED' } })
    );
    securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(9999);

    await expect(middleware(jest.fn(), null, {}, ctx, info)).rejects.toThrow('Too many requests');
    expect(securityManager.complexityAnalyzer.calculate).not.toHaveBeenCalled();
  });
});
