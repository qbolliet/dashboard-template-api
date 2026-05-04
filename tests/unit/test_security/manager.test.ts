/**
 * Unit tests for SecurityManager (src/security/manager.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger; imports from the security index barrel.
 * Covers constructor, createSecurityMiddleware, validateRequest,
 * shouldSkipRateLimit, isOperationAllowed, and integration scenarios.
 */

import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration mockée complète du gestionnaire de sécurité. */
interface MockConfig {
  SECURITY: {
    RATE_LIMIT: {
      MAX_REQUESTS:        number;
      WINDOW_MS:           number;
      MAX_BURST_REQUESTS:  number;
      BURST_WINDOW_MS:     number;
      SKIP_FAILED_REQUESTS: boolean;
      TRUSTED_PROXIES:     string[];
    };
    COMPLEXITY: {
      MAX_ALLOWED:        number;
      SCALAR_COST:        number;
      OBJECT_COST:        number;
      LIST_FACTOR:        number;
      DEPTH_FACTOR:       number;
      INTROSPECTION_COST: number;
      CUSTOM_SCORES:      Record<string, number>;
    };
    SANITIZATION: {
      ENABLE_XSS:        boolean;
      ENABLE_SQL:        boolean;
      MAX_STRING_LENGTH: number;
      ALLOWED_TAGS:      string[];
      CUSTOM_SANITIZERS: Record<string, unknown>;
    };
  };
  SECURITY_LIMITS: { COMPLEXITY_CALCULATION_FACTOR: number };
  SECURITY_PATTERNS: { blocked: unknown[]; allowed: unknown[] };
  API: { SECURITY_THRESHOLDS: { QUERY_SNIPPET_LENGTH: number } };
}

/** Logger contextuel mocké — toutes les méthodes de journalisation. */
interface MockLogger {
  security:    jest.Mock;
  operation:   jest.Mock;
  warn:        jest.Mock;
  error:       jest.Mock;
  database:    jest.Mock;
  cache:       jest.Mock;
  performance: jest.Mock;
}

/** Contexte GraphQL minimal pour les tests du gestionnaire de sécurité. */
interface MockContext {
  requestId: string;
  req?:      { ip: string; headers: Record<string, string> };
}

/** Nœud Field minimal pour les tests de calculate. */
interface MockFieldNode {
  kind:         'Field';
  name:         { value: string };
  arguments:    unknown[];
  selectionSet: null;
}

/** Sous-ensemble de GraphQLResolveInfo suffisant pour les tests. */
interface MockInfo {
  fieldName:      string;
  fieldNodes:     MockFieldNode[];
  schema:         null;
  fragments:      Record<string, unknown>;
  variableValues: Record<string, unknown>;
}

/** Opération GraphQL minimale pour les tests de validateRequest. */
interface MockOperation {
  operation?: string;
  name?:      { value: string };
}

/** Requête HTTP minimale pour les tests de validateRequest. */
interface MockRequest {
  query?: string;
}

/**
 * Interface étendue du SecurityManager exposant les propriétés privées
 * nécessaires aux assertions des tests.
 *
 * Utilisation via double-cast `as unknown as SecurityManagerTest` pour
 * contourner les restrictions d'accès TypeScript sur les membres privés.
 */
interface SecurityManagerTest {
  config:             Record<string, unknown>;
  rateLimiter:        { checkLimit:    jest.Mock | ((req: unknown) => Promise<unknown>) };
  complexityAnalyzer: { calculate:     jest.Mock | ((info: unknown) => number) };
  inputSanitizer:     { sanitizeAll:   jest.Mock | ((args: unknown) => unknown) };
  patternValidator:   { validateQuery: jest.Mock | ((query: unknown) => Promise<void>) };
  createSecurityMiddleware: () => (
    resolve:  jest.Mock,
    root:     unknown,
    args:     unknown,
    context:  unknown,
    info:     unknown
  ) => Promise<unknown>;
  validateRequest:      (op: MockOperation, req: MockRequest, ctx: MockContext) => Promise<void>;
  shouldSkipRateLimit:  (info: { fieldName: string }) => boolean;
  isOperationAllowed:   (name: string) => boolean;
  cleanup:              () => Promise<void>;
}

/** Constructeur d'un module de sécurité (RateLimiter, InputSanitizer, etc.). */
interface SecurityModuleConstructor {
  new(...args: unknown[]): unknown;
}

/** Constructeur du SecurityManager. */
interface SecurityManagerConstructor {
  new(config?: Record<string, unknown>): SecurityManagerTest;
}

// ─── Configuration mockée ─────────────────────────────────────────────────────

const mockConfig: MockConfig = {
  SECURITY: {
    RATE_LIMIT: {
      MAX_REQUESTS:         100,
      WINDOW_MS:            60000,
      MAX_BURST_REQUESTS:   20,
      BURST_WINDOW_MS:      60000,
      SKIP_FAILED_REQUESTS: false,
      TRUSTED_PROXIES:      []
    },
    COMPLEXITY: {
      MAX_ALLOWED:        1000,
      SCALAR_COST:        0,
      OBJECT_COST:        1,
      LIST_FACTOR:        10,
      DEPTH_FACTOR:       2,
      INTROSPECTION_COST: 100,
      CUSTOM_SCORES:      {}
    },
    SANITIZATION: {
      ENABLE_XSS:        true,
      ENABLE_SQL:        true,
      MAX_STRING_LENGTH: 10000,
      ALLOWED_TAGS:      [],
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

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: (): MockLogger => ({
    security:    jest.fn(),
    operation:   jest.fn(),
    warn:        jest.fn(),
    error:       jest.fn(),
    database:    jest.fn(),
    cache:       jest.fn(),
    performance: jest.fn()
  })
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertions d'assignation définitive — assignés dans beforeAll avant tout test.
let SecurityManager!:          SecurityManagerConstructor;
let RateLimiter!:              SecurityModuleConstructor;
let QueryComplexityAnalyzer!:  SecurityModuleConstructor;
let InputSanitizer!:           SecurityModuleConstructor;
let PatternValidator!:         SecurityModuleConstructor;

beforeAll(async () => {
  ({
    SecurityManager,
    RateLimiter,
    QueryComplexityAnalyzer,
    InputSanitizer,
    PatternValidator
  } = await import('../../../src/security/index.js') as {
    SecurityManager:         SecurityManagerConstructor;
    RateLimiter:             SecurityModuleConstructor;
    QueryComplexityAnalyzer: SecurityModuleConstructor;
    InputSanitizer:          SecurityModuleConstructor;
    PatternValidator:        SecurityModuleConstructor;
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SecurityManager', () => {
  // Double-cast nécessaire pour accéder aux propriétés privées du gestionnaire
  let securityManager!: SecurityManagerTest;

  const mockContext: MockContext = {
    requestId: 'test-request-id',
    req:       { ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } }
  };

  const mockInfo: MockInfo = {
    fieldName:  'testField',
    fieldNodes: [{
      kind:         'Field',
      name:         { value: 'testField' },
      arguments:    [],
      selectionSet: null
    }],
    schema:         null,
    fragments:      {},
    variableValues: {}
  };

  beforeEach(() => {
    jest.clearAllMocks();
    securityManager = new SecurityManager() as unknown as SecurityManagerTest;
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
        RATE_LIMIT:   { MAX_REQUESTS: 5, WINDOW_MS: 60000, MAX_BURST_REQUESTS: 2, BURST_WINDOW_MS: 60000, TRUSTED_PROXIES: [] },
        COMPLEXITY:   { MAX_ALLOWED: 500, SCALAR_COST: 0, OBJECT_COST: 1, LIST_FACTOR: 10, DEPTH_FACTOR: 2, INTROSPECTION_COST: 100, CUSTOM_SCORES: {} },
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

      // Remplacement des méthodes par des mocks pour isoler le comportement du middleware
      securityManager.rateLimiter.checkLimit        = jest.fn().mockResolvedValue({ limit: 100, remaining: 99 });
      securityManager.complexityAnalyzer.calculate  = jest.fn().mockReturnValue(100);
      securityManager.inputSanitizer.sanitizeAll    = jest.fn().mockReturnValue({});

      const result = await middleware(mockResolve, null, {}, mockContext, mockInfo);

      expect(securityManager.rateLimiter.checkLimit as jest.Mock).toHaveBeenCalled();
      expect(securityManager.complexityAnalyzer.calculate as jest.Mock).toHaveBeenCalled();
      expect(securityManager.inputSanitizer.sanitizeAll as jest.Mock).toHaveBeenCalled();
      expect(mockResolve).toHaveBeenCalled();
      expect(result).toBe('test-result');
    });

    test('propagates rate-limit error', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      // Simulation d'un dépassement de la limite de taux
      securityManager.rateLimiter.checkLimit = jest.fn().mockRejectedValue(
        new GraphQLError('Too many requests', { extensions: { code: 'RATE_LIMIT_EXCEEDED' } })
      );

      await expect(
        middleware(jest.fn(), null, {}, mockContext, mockInfo)
      ).rejects.toThrow(GraphQLError);
    });

    test('throws when complexity exceeds MAX_ALLOWED', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      securityManager.rateLimiter.checkLimit       = jest.fn().mockResolvedValue({ limit: 100, remaining: 99 });
      // Score de complexité de 2000 — dépasse le MAX_ALLOWED de 1000
      securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(2000);

      await expect(
        middleware(jest.fn(), null, {}, mockContext, mockInfo)
      ).rejects.toThrow(GraphQLError);
    });

    test('skips rate-limit check when req is absent', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      // Contexte sans req — le rate-limit ne doit pas être vérifié
      const noReqContext: MockContext = { requestId: 'no-req' };
      securityManager.rateLimiter.checkLimit       = jest.fn().mockResolvedValue({});
      securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(0);
      securityManager.inputSanitizer.sanitizeAll   = jest.fn().mockReturnValue({});

      await middleware(jest.fn().mockResolvedValue('ok'), null, {}, noReqContext, mockInfo);
      expect(securityManager.rateLimiter.checkLimit as jest.Mock).not.toHaveBeenCalled();
    });
  });

  describe('validateRequest', () => {
    test('passes for a normal query', async () => {
      const operation: MockOperation = { operation: 'query', name: { value: 'MyQuery' } };
      const request: MockRequest     = { query: 'query { test }' };
      await expect(securityManager.validateRequest(operation, request, mockContext)).resolves.toBeUndefined();
    });

    test('throws for mutation operations', async () => {
      // Mutation interdite — seules les queries sont autorisées
      const operation: MockOperation = { operation: 'mutation', name: { value: 'MyMutation' } };
      const request: MockRequest     = {};
      await expect(securityManager.validateRequest(operation, request, mockContext))
        .rejects.toThrow(GraphQLError);
    });

    test('throws for subscription operations', async () => {
      const operation: MockOperation = { operation: 'subscription', name: { value: 'MySub' } };
      const request: MockRequest     = {};
      await expect(securityManager.validateRequest(operation, request, mockContext))
        .rejects.toThrow(GraphQLError);
    });

    test('calls patternValidator when request.query is present', async () => {
      securityManager.patternValidator.validateQuery = jest.fn().mockResolvedValue(undefined);
      const operation: MockOperation = { operation: 'query' };
      const request: MockRequest     = { query: 'query { test }' };
      await securityManager.validateRequest(operation, request, mockContext);
      expect(securityManager.patternValidator.validateQuery as jest.Mock).toHaveBeenCalledWith('query { test }');
    });
  });

  describe('shouldSkipRateLimit', () => {
    test('returns false for regular fields', () => {
      expect(securityManager.shouldSkipRateLimit({ fieldName: 'facts' })).toBe(false);
    });

    test('returns true for __schema in non-production', () => {
      // Introspection autorisée hors production — rate-limit ignoré
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

// ─── Intégration ──────────────────────────────────────────────────────────────

describe('Security integration', () => {
  let securityManager!: SecurityManagerTest;

  afterEach(async () => {
    if (securityManager) await securityManager.cleanup();
  });

  test('middleware passes clean request end-to-end', async () => {
    securityManager = new SecurityManager() as unknown as SecurityManagerTest;
    const middleware  = securityManager.createSecurityMiddleware();
    const mockResolve = jest.fn().mockResolvedValue('result');
    const ctx: MockContext = {
      requestId: 'int-test',
      req:       { ip: '127.0.0.1', headers: { 'user-agent': 'test' } }
    };
    const info: MockInfo = {
      fieldName:  'testQuery',
      fieldNodes: [{ kind: 'Field', name: { value: 'simpleField' }, arguments: [], selectionSet: null }],
      schema:         null,
      fragments:      {},
      variableValues: {}
    };

    // Mocks des sous-modules — scénario nominal sans dépassement de limite
    securityManager.rateLimiter.checkLimit       = jest.fn().mockResolvedValue({ limit: 100, remaining: 99 });
    securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(50);
    securityManager.inputSanitizer.sanitizeAll   = jest.fn().mockReturnValue({ input: 'clean' });

    const result = await middleware(mockResolve, null, { input: 'clean' }, ctx, info);
    expect(result).toBe('result');
  });

  test('rate-limit violation is reported before complexity check', async () => {
    securityManager = new SecurityManager() as unknown as SecurityManagerTest;
    const middleware = securityManager.createSecurityMiddleware();
    const ctx: MockContext = {
      requestId: 'viol-test',
      req:       { ip: '127.0.0.1', headers: { 'user-agent': 'test' } }
    };
    const info: MockInfo = {
      fieldName:  'testQuery',
      fieldNodes: [{ kind: 'Field', name: { value: 'simpleField' }, arguments: [], selectionSet: null }],
      schema:         null,
      fragments:      {},
      variableValues: {}
    };

    // Rate-limit déclenché en premier — la complexité ne doit pas être calculée
    securityManager.rateLimiter.checkLimit = jest.fn().mockRejectedValue(
      new GraphQLError('Too many requests', { extensions: { code: 'RATE_LIMIT_EXCEEDED' } })
    );
    securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(9999);

    await expect(middleware(jest.fn(), null, {}, ctx, info)).rejects.toThrow('Too many requests');
    expect(securityManager.complexityAnalyzer.calculate as jest.Mock).not.toHaveBeenCalled();
  });
});
