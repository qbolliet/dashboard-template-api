// Importation des types et classes GraphQL
import { GraphQLError } from 'graphql';
import type { DocumentNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import type { RequestHandler } from 'express';
import { createContextLogger } from '../utils/logger.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryComplexityAnalyzer } from './complexity-analyzer.js';
import { PatternValidator } from './pattern-validator.js';
import { createRateLimitMiddleware } from './rate-limit-middleware.js';
import { config } from '../utils/config-loader.js';
import type { ContextLogger } from '../utils/logger.js';
import type { RateLimitInfo, HttpRequest } from './rate-limiter.js';
import type { SecurityConfig } from '../utils/config-loader.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Extended GraphQL context carrying security-related request information. */
interface GraphQLContext {
  req?: HttpRequest;
  requestId?: string;
  rateLimitInfo?: RateLimitInfo;
  [key: string]: unknown;
}

/** Minimal representation of a GraphQL operation used for validation. */
interface GraphQLOperation {
  name?: { value?: string };
  operation?: string;
}

/** Minimal representation of an HTTP request used for document-level validation. */
interface GraphQLRequest {
  query?: string;
}

// ─── Classe gestionnaire de sécurité ────────────────────────────────────────

// Pas de sanitization XSS/SQL sur le chemin GraphQL — décision assumée :
//  - les valeurs de filtre ne sont jamais concaténées au SQL (treeToSQL produit
//    { sql, params } et DuckDB reçoit des paramètres liés) ;
//  - les identifiants (fields, sort, groupBy, measure) passent par
//    validateIdentifier ;
//  - les motifs interdits sont rejetés en amont par PatternValidator, et les
//    mutations/subscriptions par validateRequest.
// Échapper en plus les valeurs corromprait des données légitimes : les libellés
// stockés en base contiennent apostrophes et tirets (« Côte-d'Or »), et le
// rejet sur « -- » ou « /* » produirait des faux positifs sur du texte libre.

/**
 * Orchestrates all security modules for GraphQL request processing.
 *
 * Acts as the single coordinator for rate limiting, complexity analysis, and
 * pattern validation. Exposes an Express middleware factory for rate limiting
 * and document-level validation hooks for Apollo Server's plugin system.
 */
class SecurityManager {
  private config: SecurityConfig;
  private logger: ContextLogger;
  private rateLimiter: RateLimiter;
  private complexityAnalyzer: QueryComplexityAnalyzer;
  private patternValidator: PatternValidator;

  /**
   * Initializes all security sub-modules from the provided configuration.
   *
   * @param securityConfig - Security section of the application configuration.
   */
  constructor(securityConfig: SecurityConfig = config.SECURITY) {
    this.config = securityConfig;
    this.logger = createContextLogger({ component: 'security' });

    // Instanciation des modules de sécurité
    this.rateLimiter = new RateLimiter(
      this.config.RATE_LIMIT as unknown as Record<string, unknown>,
    );
    this.complexityAnalyzer = new QueryComplexityAnalyzer(
      this.config.COMPLEXITY as unknown as Record<string, unknown>,
    );
    this.patternValidator = new PatternValidator();

    // Journalisation de l'initialisation complète
    this.logger.operation('SecurityManager initialized', {
      modules: ['rateLimiter', 'complexityAnalyzer', 'patternValidator'],
    });
  }

  /**
   * Builds the Express rate-limiting middleware backed by this manager's limiter.
   *
   * Mount it on every publicly reachable route prefix (/graphql, and later the
   * export endpoint) before any expensive handler. All routes share a single
   * limiter instance, hence a single budget per client.
   *
   * @returns Express request handler replying 429 when the limit is exceeded.
   */
  createRateLimitMiddleware(): RequestHandler {
    const enabled = (this.config.RATE_LIMIT as { ENABLED?: boolean })?.ENABLED ?? true;
    return createRateLimitMiddleware(this.rateLimiter, { enabled });
  }

  /**
   * Rejects operations whose complexity score exceeds the configured ceiling.
   *
   * Called from the Apollo `didResolveOperation` hook, i.e. after parsing and
   * validation but before any resolver runs: an over-budget query never
   * reaches the database. Per-field scores come from
   * SECURITY.COMPLEXITY.CUSTOM_SCORES in config/security.yaml.
   *
   * @param document - Parsed GraphQL document, source of the named fragments.
   * @param operation - Operation definition selected for execution.
   * @param variables - Resolved variable values for the operation.
   * @param context - GraphQL execution context, used for log correlation.
   * @throws {GraphQLError} QUERY_COMPLEXITY_EXCEEDED when the score is too high.
   */
  validateComplexity(
    document: DocumentNode,
    operation: OperationDefinitionNode,
    variables: Record<string, unknown> = {},
    context: GraphQLContext = {},
  ): void {
    // Exemption de l'introspection : son coût dédié (INTROSPECTION_COST) dépasse
    // volontairement le plafond et rejetterait Sandbox, le codegen et la
    // génération de doc. L'introspection reste désactivée en production.
    if (this.isIntrospectionOperation(operation)) {
      return;
    }

    // Indexation des fragments nommés déclarés dans le document
    const fragments: Record<string, FragmentDefinitionNode> = {};
    for (const definition of document.definitions) {
      if (definition.kind === 'FragmentDefinition') {
        fragments[definition.name.value] = definition;
      }
    }

    const complexity = this.complexityAnalyzer.calculateForOperation(
      operation,
      fragments,
      variables,
    );
    const maxAllowed = this.config.COMPLEXITY.MAX_ALLOWED;

    if (complexity > maxAllowed) {
      this.logger.security('Query complexity exceeded', {
        requestId: context.requestId,
        operationName: operation.name?.value ?? 'anonymous',
        complexity,
        maxAllowed,
      });

      throw new GraphQLError(
        `Query too complex: score ${Math.round(complexity)} exceeds the maximum of ${maxAllowed}. ` +
          'Request fewer fields, reduce the nesting depth, or lower the limit argument.',
        {
          extensions: {
            code: 'QUERY_COMPLEXITY_EXCEEDED',
            complexity,
            maxAllowed,
          },
        },
      );
    }

    // Journalisation systématique des scores en mode debug
    if (this.config.MONITORING?.LOG_ALL_METRICS) {
      this.logger.security('Query complexity accepted', {
        requestId: context.requestId,
        operationName: operation.name?.value ?? 'anonymous',
        complexity,
        maxAllowed,
      });
    }
  }

  /**
   * Determines whether an operation only selects introspection fields.
   *
   * @param operation - Operation definition to inspect.
   * @returns True when every root selection is an introspection field.
   */
  private isIntrospectionOperation(operation: OperationDefinitionNode): boolean {
    const selections = operation.selectionSet?.selections ?? [];
    if (selections.length === 0) {
      return false;
    }
    return selections.every(
      (selection) => selection.kind === 'Field' && selection.name.value.startsWith('__'),
    );
  }

  /**
   * Validates a GraphQL operation before execution begins.
   *
   * Checks for forbidden query patterns, disallowed operation names,
   * and non-query operation types (mutations and subscriptions are blocked).
   *
   * @param operation - Parsed GraphQL operation definition.
   * @param request - Raw HTTP request containing the query string.
   * @param context - GraphQL execution context for logging.
   * @throws {GraphQLError} When the operation fails any validation check.
   */
  async validateRequest(
    operation: GraphQLOperation,
    request: GraphQLRequest,
    context: GraphQLContext,
  ): Promise<void> {
    const validations: Promise<void>[] = [];

    // 1. Validation des patterns dangereux dans la chaîne de requête brute
    if (request.query) {
      validations.push(
        this.patternValidator.validateQuery(request.query).catch((err: unknown) => {
          this.logger.security('Pattern validation failed', {
            error: (err as Error).message,
            requestId: context.requestId,
          });
          throw err;
        }),
      );
    }

    // 2. Validation du nom de l'opération
    const operationName = operation?.name?.value;
    if (operationName && !this.isOperationAllowed(operationName)) {
      throw new GraphQLError(`Operation ${operationName} is not allowed`, {
        extensions: { code: 'OPERATION_NOT_ALLOWED' },
      });
    }

    // 3. Restriction aux requêtes (mutations et subscriptions interdites)
    if (operation?.operation && operation.operation !== 'query') {
      throw new GraphQLError(`Only queries are allowed, got ${operation.operation}`, {
        extensions: { code: 'OPERATION_TYPE_NOT_ALLOWED' },
      });
    }

    await Promise.all(validations);
  }

  /**
   * Determines whether a named operation is permitted to execute.
   *
   * @param operationName - Name of the GraphQL operation.
   * @returns True when the operation may proceed.
   */
  private isOperationAllowed(operationName: string): boolean {
    // Autorisation de l'introspection en dehors de la production
    if (process.env['NODE_ENV'] !== 'production' && operationName === 'IntrospectionQuery') {
      return true;
    }
    // Toutes les opérations nommées sont autorisées par défaut
    return true;
  }

  /**
   * Releases resources held by the security manager.
   */
  async cleanup(): Promise<void> {
    this.logger.security('Cleaning up SecurityManager resources');
    await this.rateLimiter.cleanup();
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

// Instance globale du gestionnaire de sécurité (pattern singleton)
let securityManagerInstance: SecurityManager | null = null;

/**
 * Initializes the global SecurityManager singleton with a given configuration.
 *
 * @param securityConfig - Security configuration to pass to the constructor.
 * @returns The newly created SecurityManager instance.
 * @throws {Error} When the singleton has already been initialized.
 */
const initializeSecurityManager = (securityConfig: SecurityConfig): SecurityManager => {
  if (securityManagerInstance) {
    throw new Error('SecurityManager already initialized');
  }
  securityManagerInstance = new SecurityManager(securityConfig);
  return securityManagerInstance;
};

/**
 * Returns the global SecurityManager singleton, initializing with defaults if needed.
 *
 * @returns The active SecurityManager instance.
 */
const getSecurityManager = (): SecurityManager => {
  if (!securityManagerInstance) {
    // Initialisation avec la configuration YAML par défaut
    securityManagerInstance = new SecurityManager();
  }
  return securityManagerInstance;
};

export { SecurityManager, initializeSecurityManager, getSecurityManager };
export type { GraphQLContext, GraphQLOperation, GraphQLRequest };
