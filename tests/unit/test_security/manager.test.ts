/**
 * Unit tests for SecurityManager (src/security/manager.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger; imports from the security index barrel.
 * Covers constructor, createRateLimitMiddleware, validateRequest,
 * validateComplexity, isOperationAllowed, and integration scenarios.
 */

import { jest } from '@jest/globals';
import { GraphQLError, parse } from 'graphql';
import type { DocumentNode, OperationDefinitionNode } from 'graphql';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Configuration mockée complète du gestionnaire de sécurité. */
interface MockConfig {
  SECURITY: {
    RATE_LIMIT: {
      MAX_REQUESTS: number;
      WINDOW_MS: number;
      MAX_BURST_REQUESTS: number;
      BURST_WINDOW_MS: number;
      SKIP_FAILED_REQUESTS: boolean;
      TRUSTED_PROXIES: string[];
    };
    COMPLEXITY: {
      MAX_ALLOWED: number;
      SCALAR_COST: number;
      OBJECT_COST: number;
      LIST_FACTOR: number;
      DEPTH_FACTOR: number;
      INTROSPECTION_COST: number;
      CUSTOM_SCORES: Record<string, number>;
    };
  };
  SECURITY_LIMITS: { COMPLEXITY_CALCULATION_FACTOR: number };
  SECURITY_PATTERNS: { blocked: unknown[]; allowed: unknown[] };
  API: { SECURITY_THRESHOLDS: { QUERY_SNIPPET_LENGTH: number } };
}

/** Logger contextuel mocké — toutes les méthodes de journalisation. */
interface MockLogger {
  security: jest.Mock;
  operation: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  database: jest.Mock;
  cache: jest.Mock;
  performance: jest.Mock;
}

/** Contexte GraphQL minimal pour les tests du gestionnaire de sécurité. */
interface MockContext {
  requestId: string;
  req?: { ip: string; headers: Record<string, string> };
}

/** Opération GraphQL minimale pour les tests de validateRequest. */
interface MockOperation {
  operation?: string;
  name?: { value: string };
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
  config: Record<string, unknown>;
  rateLimiter: { checkLimit: jest.Mock | ((req: unknown) => Promise<unknown>) };
  complexityAnalyzer: {
    calculateForOperation: jest.Mock | ((op: unknown, fr?: unknown, va?: unknown) => number);
  };
  patternValidator: { validateQuery: jest.Mock | ((query: unknown) => Promise<void>) };
  createRateLimitMiddleware: () => (req: unknown, res: unknown, next: unknown) => void;
  validateRequest: (op: MockOperation, req: MockRequest, ctx: MockContext) => Promise<void>;
  validateComplexity: (
    document: DocumentNode,
    operation: OperationDefinitionNode,
    variables?: Record<string, unknown>,
    context?: MockContext,
  ) => void;
  isOperationAllowed: (name: string) => boolean;
  cleanup: () => Promise<void>;
}

/** Constructeur d'un module de sécurité (RateLimiter, PatternValidator, etc.). */
interface SecurityModuleConstructor {
  new (...args: unknown[]): unknown;
}

/** Constructeur du SecurityManager. */
interface SecurityManagerConstructor {
  new (config?: Record<string, unknown>): SecurityManagerTest;
}

// ─── Configuration mockée ─────────────────────────────────────────────────────

const mockConfig: MockConfig = {
  SECURITY: {
    RATE_LIMIT: {
      MAX_REQUESTS: 100,
      WINDOW_MS: 60000,
      MAX_BURST_REQUESTS: 20,
      BURST_WINDOW_MS: 60000,
      SKIP_FAILED_REQUESTS: false,
      TRUSTED_PROXIES: [],
    },
    COMPLEXITY: {
      MAX_ALLOWED: 1000,
      SCALAR_COST: 0,
      OBJECT_COST: 1,
      LIST_FACTOR: 10,
      DEPTH_FACTOR: 2,
      INTROSPECTION_COST: 100,
      CUSTOM_SCORES: {},
    },
  },
  SECURITY_LIMITS: {
    COMPLEXITY_CALCULATION_FACTOR: 0.1,
  },
  SECURITY_PATTERNS: {
    blocked: [],
    allowed: [],
  },
  API: {
    SECURITY_THRESHOLDS: {
      QUERY_SNIPPET_LENGTH: 100,
    },
  },
};

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: (): MockLogger => ({
    security: jest.fn(),
    operation: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    database: jest.fn(),
    cache: jest.fn(),
    performance: jest.fn(),
  }),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertions d'assignation définitive — assignés dans beforeAll avant tout test.
let SecurityManager!: SecurityManagerConstructor;
let RateLimiter!: SecurityModuleConstructor;
let QueryComplexityAnalyzer!: SecurityModuleConstructor;
let PatternValidator!: SecurityModuleConstructor;

beforeAll(async () => {
  ({ SecurityManager, RateLimiter, QueryComplexityAnalyzer, PatternValidator } =
    (await import('../../../src/security/index.js')) as {
      SecurityManager: SecurityManagerConstructor;
      RateLimiter: SecurityModuleConstructor;
      QueryComplexityAnalyzer: SecurityModuleConstructor;
      PatternValidator: SecurityModuleConstructor;
    });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SecurityManager', () => {
  // Double-cast nécessaire pour accéder aux propriétés privées du gestionnaire
  let securityManager!: SecurityManagerTest;

  const mockContext: MockContext = {
    requestId: 'test-request-id',
    req: { ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } },
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
        RATE_LIMIT: {
          MAX_REQUESTS: 5,
          WINDOW_MS: 60000,
          MAX_BURST_REQUESTS: 2,
          BURST_WINDOW_MS: 60000,
          TRUSTED_PROXIES: [],
        },
        COMPLEXITY: {
          MAX_ALLOWED: 500,
          SCALAR_COST: 0,
          OBJECT_COST: 1,
          LIST_FACTOR: 10,
          DEPTH_FACTOR: 2,
          INTROSPECTION_COST: 100,
          CUSTOM_SCORES: {},
        },
      };
      const custom = new SecurityManager(customConfig);
      expect(custom.config).toEqual(customConfig);
      custom.cleanup();
    });

    test('creates sub-modules of the correct classes', () => {
      expect(securityManager.rateLimiter).toBeInstanceOf(RateLimiter);
      expect(securityManager.complexityAnalyzer).toBeInstanceOf(QueryComplexityAnalyzer);
      expect(securityManager.patternValidator).toBeInstanceOf(PatternValidator);
    });
  });

  describe('createRateLimitMiddleware', () => {
    test('returns an Express middleware function of three arguments', () => {
      const middleware = securityManager.createRateLimitMiddleware();
      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3);
    });
  });

  describe('validateComplexity', () => {
    /**
     * Parses a query and validates it against the manager's ceiling.
     *
     * @param source - GraphQL document source.
     * @returns Nothing; throws when the operation is over budget.
     */
    const validate = (source: string): void => {
      const document: DocumentNode = parse(source);
      const operation = document.definitions.find(
        (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition',
      ) as OperationDefinitionNode;
      securityManager.validateComplexity(document, operation, {}, mockContext);
    };

    test('accepts an operation below the ceiling', () => {
      expect(() => validate('{ getFactTable { id } }')).not.toThrow();
    });

    test('throws QUERY_COMPLEXITY_EXCEEDED above the ceiling', () => {
      // Score simulé très au-dessus du MAX_ALLOWED de 1000
      securityManager.complexityAnalyzer.calculateForOperation = jest.fn().mockReturnValue(5000);
      try {
        validate('{ getFactTable { id } }');
        throw new Error('expected validateComplexity to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        const error = e as GraphQLError;
        expect(error.extensions.code).toBe('QUERY_COMPLEXITY_EXCEEDED');
        expect(error.extensions.complexity).toBe(5000);
        expect(error.extensions.maxAllowed).toBe(1000);
        // Message explicite : score, plafond et piste de correction
        expect(error.message).toContain('5000');
        expect(error.message).toContain('1000');
      }
    });

    test('skips the check for introspection-only operations', () => {
      // Le coût d'introspection dépasse volontairement le plafond
      securityManager.complexityAnalyzer.calculateForOperation = jest.fn();
      expect(() =>
        validate('query IntrospectionQuery { __schema { types { name } } }'),
      ).not.toThrow();
      expect(
        securityManager.complexityAnalyzer.calculateForOperation as jest.Mock,
      ).not.toHaveBeenCalled();
    });

    test('still scores an operation mixing introspection and data fields', () => {
      securityManager.complexityAnalyzer.calculateForOperation = jest.fn().mockReturnValue(1);
      validate('{ __typename getFactTable { id } }');
      expect(
        securityManager.complexityAnalyzer.calculateForOperation as jest.Mock,
      ).toHaveBeenCalled();
    });

    test('passes named fragments of the document to the analyzer', () => {
      securityManager.complexityAnalyzer.calculateForOperation = jest.fn().mockReturnValue(1);
      validate('{ getFactTable { ...F } } fragment F on Fact { id }');
      const call = (securityManager.complexityAnalyzer.calculateForOperation as jest.Mock).mock
        .calls[0];
      expect(Object.keys(call[1] as Record<string, unknown>)).toEqual(['F']);
    });
  });

  describe('validateRequest', () => {
    test('passes for a normal query', async () => {
      const operation: MockOperation = { operation: 'query', name: { value: 'MyQuery' } };
      const request: MockRequest = { query: 'query { test }' };
      await expect(
        securityManager.validateRequest(operation, request, mockContext),
      ).resolves.toBeUndefined();
    });

    test('throws for mutation operations', async () => {
      // Mutation interdite — seules les queries sont autorisées
      const operation: MockOperation = { operation: 'mutation', name: { value: 'MyMutation' } };
      const request: MockRequest = {};
      await expect(
        securityManager.validateRequest(operation, request, mockContext),
      ).rejects.toThrow(GraphQLError);
    });

    test('throws for subscription operations', async () => {
      const operation: MockOperation = { operation: 'subscription', name: { value: 'MySub' } };
      const request: MockRequest = {};
      await expect(
        securityManager.validateRequest(operation, request, mockContext),
      ).rejects.toThrow(GraphQLError);
    });

    test('calls patternValidator when request.query is present', async () => {
      securityManager.patternValidator.validateQuery = jest.fn().mockResolvedValue(undefined);
      const operation: MockOperation = { operation: 'query' };
      const request: MockRequest = { query: 'query { test }' };
      await securityManager.validateRequest(operation, request, mockContext);
      expect(securityManager.patternValidator.validateQuery as jest.Mock).toHaveBeenCalledWith(
        'query { test }',
      );
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

  const integrationContext: MockContext = { requestId: 'integration-test' };

  afterEach(async () => {
    if (securityManager) await securityManager.cleanup();
  });

  test('rate-limit middleware rejects with 429 once the budget is exhausted', async () => {
    // Budget d'une seule requête — la seconde doit être refusée
    securityManager = new SecurityManager({
      RATE_LIMIT: {
        MAX_REQUESTS: 1,
        WINDOW_MS: 60000,
        MAX_BURST_REQUESTS: 1,
        BURST_WINDOW_MS: 60000,
        TRUSTED_PROXIES: [],
      },
      COMPLEXITY: mockConfig.SECURITY.COMPLEXITY,
    }) as unknown as SecurityManagerTest;

    const middleware = securityManager.createRateLimitMiddleware();
    const req = { ip: '127.0.0.1', headers: { 'user-agent': 'int-test' } };
    const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };

    // Première requête acceptée
    const firstNext = jest.fn();
    middleware(req, res, firstNext);
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstNext).toHaveBeenCalled();

    // Seconde requête refusée — 429 avec Retry-After, sans appel au suivant
    const secondNext = jest.fn();
    middleware(req, res, secondNext);
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  test('validateComplexity rejects a deeply nested query end-to-end', () => {
    // Plafond très bas — une requête imbriquée réelle doit le dépasser
    securityManager = new SecurityManager({
      RATE_LIMIT: mockConfig.SECURITY.RATE_LIMIT,
      COMPLEXITY: { ...mockConfig.SECURITY.COMPLEXITY, MAX_ALLOWED: 2 },
    }) as unknown as SecurityManagerTest;

    const document: DocumentNode = parse('{ a { b { c { d { e } } } } }');
    const operation = document.definitions[0] as OperationDefinitionNode;

    expect(() =>
      securityManager.validateComplexity(document, operation, {}, integrationContext),
    ).toThrow(GraphQLError);
  });
});
