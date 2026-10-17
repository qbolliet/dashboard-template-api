/**
 * Unit tests for SecurityManager (src/security/manager.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks config-loader and logger; imports from the security index barrel.
 * Covers constructor, createRateLimitMiddleware, validateRequest,
 * validateComplexity (score and root-field ceilings), and
 * integration scenarios.
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
      TRUSTED_PROXIES: string[];
    };
    COMPLEXITY: {
      MAX_ALLOWED: number;
      MAX_ROOT_FIELDS: number;
      SCALAR_COST: number;
      OBJECT_COST: number;
      DEPTH_FACTOR: number;
      INTROSPECTION_COST: number;
      ROW_COST: number;
      STATS_COST_PER_COLUMN: number;
      DEFAULT_ROOT_FIELD_SCORE: number;
      ROOT_FIELD_SCORES: Record<string, number>;
    };
  };
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
  adminRateLimiter: { cleanupInterval: unknown };
  complexityAnalyzer: {
    calculateForOperation:
      | jest.Mock
      | ((op: unknown, fr?: unknown, va?: unknown, opts?: unknown) => Promise<number>);
  };
  createRateLimitMiddleware: () => (req: unknown, res: unknown, next: unknown) => void;
  createAdminRateLimitMiddleware: () => (req: unknown, res: unknown, next: unknown) => void;
  validateRequest: (op: MockOperation) => void;
  validateComplexity: (
    document: DocumentNode,
    operation: OperationDefinitionNode,
    variables?: Record<string, unknown>,
    context?: MockContext,
    options?: Record<string, unknown>,
  ) => Promise<void>;
  cleanup: () => Promise<void>;
}

/** Constructeur d'un module de sécurité (RateLimiter, QueryComplexityAnalyzer). */
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
      TRUSTED_PROXIES: [],
    },
    COMPLEXITY: {
      MAX_ALLOWED: 1000,
      MAX_ROOT_FIELDS: 3,
      SCALAR_COST: 0,
      OBJECT_COST: 1,
      DEPTH_FACTOR: 2,
      INTROSPECTION_COST: 100,
      ROW_COST: 0.1,
      STATS_COST_PER_COLUMN: 5,
      DEFAULT_ROOT_FIELD_SCORE: 1,
      ROOT_FIELD_SCORES: {},
    },
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

beforeAll(async () => {
  ({ SecurityManager, RateLimiter, QueryComplexityAnalyzer } =
    (await import('../../../src/security/index.js')) as {
      SecurityManager: SecurityManagerConstructor;
      RateLimiter: SecurityModuleConstructor;
      QueryComplexityAnalyzer: SecurityModuleConstructor;
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
        COMPLEXITY: { ...mockConfig.SECURITY.COMPLEXITY, MAX_ALLOWED: 500 },
      };
      const custom = new SecurityManager(customConfig);
      expect(custom.config).toEqual(customConfig);
      custom.cleanup();
    });

    test('creates sub-modules of the correct classes', () => {
      expect(securityManager.rateLimiter).toBeInstanceOf(RateLimiter);
      expect(securityManager.adminRateLimiter).toBeInstanceOf(RateLimiter);
      expect(securityManager.adminRateLimiter).not.toBe(securityManager.rateLimiter);
      expect(securityManager.complexityAnalyzer).toBeInstanceOf(QueryComplexityAnalyzer);
    });
  });

  describe('createRateLimitMiddleware', () => {
    test('returns an Express middleware function of three arguments', () => {
      const middleware = securityManager.createRateLimitMiddleware();
      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3);
    });
  });

  describe('createAdminRateLimitMiddleware', () => {
    test('applies the 10 req/min default budget when ADMIN_RATE_LIMIT is absent', async () => {
      const middleware = securityManager.createAdminRateLimitMiddleware();
      const req = { ip: '127.0.0.1', headers: {} };
      const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      for (let i = 0; i < 11; i++) {
        middleware(req, res, next);
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(next).toHaveBeenCalledTimes(10);
      expect(res.status).toHaveBeenCalledWith(429);
    });

    test('cleanup also stops the admin limiter', async () => {
      await securityManager.cleanup();
      expect(securityManager.adminRateLimiter.cleanupInterval).toBeNull();
    });
  });

  describe('validateComplexity', () => {
    /**
     * Parses a query and validates it against the manager's ceilings.
     *
     * @param source - GraphQL document source.
     * @param options - Scoring options forwarded to the analyzer.
     * @returns Resolves when the operation is within budget.
     */
    const validate = (source: string, options: Record<string, unknown> = {}): Promise<void> => {
      const document: DocumentNode = parse(source);
      const operation = document.definitions.find(
        (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition',
      ) as OperationDefinitionNode;
      return securityManager.validateComplexity(document, operation, {}, mockContext, options);
    };

    /**
     * Runs a validation expected to fail and returns its error.
     *
     * @param source - GraphQL document source.
     * @returns The rejection error, or undefined when the validation passed.
     */
    const rejectionOf = async (source: string): Promise<GraphQLError | undefined> => {
      try {
        await validate(source);
        return undefined;
      } catch (e) {
        return e as GraphQLError;
      }
    };

    test('accepts an operation below the ceiling', async () => {
      await expect(validate('{ getFactTable { id } }')).resolves.toBeUndefined();
    });

    test('throws QUERY_COMPLEXITY_EXCEEDED above the ceiling', async () => {
      // Score simulé très au-dessus du MAX_ALLOWED de 1000
      securityManager.complexityAnalyzer.calculateForOperation = jest
        .fn<() => Promise<number>>()
        .mockResolvedValue(5000);
      const error = await rejectionOf('{ getFactTable { id } }');

      expect(error).toBeInstanceOf(GraphQLError);
      expect(error?.extensions.code).toBe('QUERY_COMPLEXITY_EXCEEDED');
      expect(error?.extensions.complexity).toBe(5000);
      expect(error?.extensions.maxAllowed).toBe(1000);
      // Refus d'une requête cliente : statut HTTP 400 plutôt que 500
      expect(error?.extensions.http).toEqual({ status: 400 });
      // Message explicite : score, plafond et piste de correction
      expect(error?.message).toContain('5000');
      expect(error?.message).toContain('1000');
    });

    test('rejects more root fields than MAX_ROOT_FIELDS before scoring', async () => {
      securityManager.complexityAnalyzer.calculateForOperation = jest.fn<() => Promise<number>>();
      // Quatre alias pour un plafond de trois champs racine
      const error = await rejectionOf('{ a: f { id } b: f { id } c: f { id } d: f { id } }');

      expect(error?.extensions.code).toBe('QUERY_COMPLEXITY_EXCEEDED');
      expect(error?.extensions.rootFields).toBe(4);
      expect(error?.extensions.maxRootFields).toBe(3);
      expect(error?.message).toContain('4 root fields');
      expect(
        securityManager.complexityAnalyzer.calculateForOperation as jest.Mock,
      ).not.toHaveBeenCalled();
    });

    test('does not count __typename as a root field', async () => {
      await expect(
        validate('{ __typename a: f { id } b: f { id } c: f { id } }'),
      ).resolves.toBeUndefined();
    });

    test('skips the check for introspection-only operations', async () => {
      // Le coût d'introspection dépasse volontairement le plafond
      securityManager.complexityAnalyzer.calculateForOperation = jest.fn<() => Promise<number>>();
      await expect(
        validate('query IntrospectionQuery { __schema { types { name } } }'),
      ).resolves.toBeUndefined();
      expect(
        securityManager.complexityAnalyzer.calculateForOperation as jest.Mock,
      ).not.toHaveBeenCalled();
    });

    test('still scores an operation mixing introspection and data fields', async () => {
      securityManager.complexityAnalyzer.calculateForOperation = jest
        .fn<() => Promise<number>>()
        .mockResolvedValue(1);
      await validate('{ __typename getFactTable { id } }');
      expect(
        securityManager.complexityAnalyzer.calculateForOperation as jest.Mock,
      ).toHaveBeenCalled();
    });

    test('passes named fragments and scoring options to the analyzer', async () => {
      securityManager.complexityAnalyzer.calculateForOperation = jest
        .fn<() => Promise<number>>()
        .mockResolvedValue(1);
      const options = { columns: { columnsOf: jest.fn(), allColumns: jest.fn() } };
      await validate('{ getFactTable { ...F } } fragment F on Fact { id }', options);
      const call = (securityManager.complexityAnalyzer.calculateForOperation as jest.Mock).mock
        .calls[0];
      expect(Object.keys(call[1] as Record<string, unknown>)).toEqual(['F']);
      expect(call[3]).toBe(options);
    });
  });

  describe('validateRequest', () => {
    test('passes for a normal query', () => {
      const operation: MockOperation = { operation: 'query', name: { value: 'MyQuery' } };
      expect(() => securityManager.validateRequest(operation)).not.toThrow();
    });

    test('throws for mutation operations', () => {
      // Mutation interdite — seules les queries sont autorisées
      const operation: MockOperation = { operation: 'mutation', name: { value: 'MyMutation' } };
      expect(() => securityManager.validateRequest(operation)).toThrow(GraphQLError);
    });

    test('throws for subscription operations', () => {
      const operation: MockOperation = { operation: 'subscription', name: { value: 'MySub' } };
      expect(() => securityManager.validateRequest(operation)).toThrow(GraphQLError);
    });

    test('never pattern-matches the operation (removed text checks)', () => {
      // « mutation », « system » : plus aucun motif appliqué au texte de la requête
      const operation: MockOperation = { operation: 'query', name: { value: 'MutationSystem' } };
      expect(() => securityManager.validateRequest(operation)).not.toThrow();
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

  test('validateComplexity rejects a deeply nested query end-to-end', async () => {
    // Plafond très bas — une requête imbriquée réelle doit le dépasser
    securityManager = new SecurityManager({
      RATE_LIMIT: mockConfig.SECURITY.RATE_LIMIT,
      COMPLEXITY: { ...mockConfig.SECURITY.COMPLEXITY, MAX_ALLOWED: 2 },
    }) as unknown as SecurityManagerTest;

    const document: DocumentNode = parse('{ a { b { c { d { e } } } } }');
    const operation = document.definitions[0] as OperationDefinitionNode;

    await expect(
      securityManager.validateComplexity(document, operation, {}, integrationContext),
    ).rejects.toThrow(GraphQLError);
  });
});
