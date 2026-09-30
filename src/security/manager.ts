// Importation des types et classes GraphQL
import { GraphQLError } from 'graphql';
import type { DocumentNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import type { RequestHandler } from 'express';
import { createContextLogger } from '../utils/logger.js';
import { previewValue } from '../utils/preview-value.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryComplexityAnalyzer } from './complexity-analyzer.js';
import { createRateLimitMiddleware } from './rate-limit-middleware.js';
import { config } from '../utils/config-loader.js';
import type { ContextLogger } from '../utils/logger.js';
import type { RateLimitInfo, HttpRequest } from './rate-limiter.js';
import type { SecurityConfig } from '../utils/config-loader.js';
import type { ScoringOptions } from './complexity-analyzer.js';

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

// ─── Classe gestionnaire de sécurité ────────────────────────────────────────

// Budget par défaut des routes d'administration : 10 requêtes par minute et par IP
const ADMIN_RATE_LIMIT_DEFAULTS: Record<string, unknown> = {
  MAX_REQUESTS: 10,
  WINDOW_MS: 60_000,
  MAX_BURST_REQUESTS: 10,
  BURST_WINDOW_MS: 60_000,
};

// Ni sanitization des valeurs ni motifs interdits sur le texte de la requête —
// décision assumée :
//  - les valeurs de filtre ne sont jamais concaténées au SQL (treeToSQL produit
//    { sql, params } et DuckDB reçoit des paramètres liés) ;
//  - les identifiants (fields, sort, groupBy, measure…) sont contrôlés contre
//    la table metadata (assertColumns) puis quotés (quoteIdent) ;
//  - les mutations et subscriptions sont refusées par validateRequest (et le
//    schéma n'a pas de type Mutation), l'introspection par la règle
//    NoIntrospection d'Apollo quand API.GRAPHQL.INTROSPECTION est faux.
// Un motif appliqué au texte brut ne protège rien (la même valeur passe par
// les variables) et rejette des requêtes légitimes (`__typename`, une
// recherche « ecosystem », une colonne « mutation_rate ») ; échapper les
// valeurs corromprait des libellés légitimes (« Côte-d'Or »).

/**
 * Orchestrates all security modules for GraphQL request processing.
 *
 * Acts as the single coordinator for rate limiting, complexity analysis, and
 * operation-type validation. Exposes an Express middleware factory for rate limiting
 * and document-level validation hooks for Apollo Server's plugin system.
 */
class SecurityManager {
  private config: SecurityConfig;
  private logger: ContextLogger;
  private rateLimiter: RateLimiter;
  private adminRateLimiter: RateLimiter;
  private complexityAnalyzer: QueryComplexityAnalyzer;

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
    // Limiteur distinct et strict des routes d'administration (budget séparé)
    this.adminRateLimiter = new RateLimiter({
      ...ADMIN_RATE_LIMIT_DEFAULTS,
      ...(this.config.ADMIN_RATE_LIMIT ?? {}),
    });
    this.complexityAnalyzer = new QueryComplexityAnalyzer(
      this.config.COMPLEXITY as unknown as Record<string, unknown>,
    );

    // Journalisation de l'initialisation complète
    this.logger.operation('SecurityManager initialized', {
      modules: ['rateLimiter', 'adminRateLimiter', 'complexityAnalyzer'],
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
   * Builds the strict rate-limiting middleware of the admin endpoints.
   *
   * Mount it on /api/cache and /api/catalog before `requireAdminKey`: every
   * request counts, rejected keys included, which bounds brute force on
   * x-admin-key. Its budget is separate from the public one
   * (SECURITY.ADMIN_RATE_LIMIT, default 10 requests per minute per IP).
   *
   * @returns Express request handler replying 429 when the limit is exceeded.
   */
  createAdminRateLimitMiddleware(): RequestHandler {
    const enabled = this.config.ADMIN_RATE_LIMIT?.ENABLED ?? true;
    return createRateLimitMiddleware(this.adminRateLimiter, { enabled });
  }

  /**
   * Rejects operations whose complexity exceeds the configured ceilings.
   *
   * Called from the Apollo `didResolveOperation` hook, i.e. after parsing and
   * validation but before any resolver runs: an over-budget query never
   * reaches the database. Two ceilings apply, both answered with
   * QUERY_COMPLEXITY_EXCEEDED: the number of root fields
   * (SECURITY.COMPLEXITY.MAX_ROOT_FIELDS, aliases included) and the score
   * (MAX_ALLOWED), computed with the scale of config/security.yaml.
   *
   * @param document - Parsed GraphQL document, source of the named fragments.
   * @param operation - Operation definition selected for execution.
   * @param variables - Resolved variable values for the operation.
   * @param context - GraphQL execution context, used for log correlation.
   * @param options - Executable schema (defaults of `limit`) and column
   *   counter of the request (price of `Metadata.stats`).
   * @throws {GraphQLError} QUERY_COMPLEXITY_EXCEEDED when a ceiling is exceeded.
   */
  async validateComplexity(
    document: DocumentNode,
    operation: OperationDefinitionNode,
    variables: Record<string, unknown> = {},
    context: GraphQLContext = {},
    options: ScoringOptions = {},
  ): Promise<void> {
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
    const operationName = operation.name?.value ?? 'anonymous';

    // Plafond du nombre de champs racine, avant tout calcul de score : chaque
    // champ racine est au moins une requête SQL ou un accès au cache
    const rootFields = this.complexityAnalyzer.countRootFields(operation, fragments);
    const maxRootFields = this.complexityAnalyzer.maxRootFields;
    if (rootFields > maxRootFields) {
      this.logger.security('Too many root fields', {
        requestId: context.requestId,
        operationName,
        rootFields,
        maxRootFields,
      });

      throw new GraphQLError(
        `Query too complex: ${rootFields} root fields exceed the maximum of ${maxRootFields}. ` +
          'Split the operation into several requests.',
        {
          extensions: {
            code: 'QUERY_COMPLEXITY_EXCEEDED',
            rootFields,
            maxRootFields,
            http: { status: 400 },
          },
        },
      );
    }

    const complexity = await this.complexityAnalyzer.calculateForOperation(
      operation,
      fragments,
      variables,
      options,
    );
    const maxAllowed = this.config.COMPLEXITY.MAX_ALLOWED;

    if (complexity > maxAllowed) {
      this.logger.security('Query complexity exceeded', {
        requestId: context.requestId,
        operationName,
        complexity,
        maxAllowed,
      });

      throw new GraphQLError(
        `Query too complex: score ${Math.round(complexity)} exceeds the maximum of ${maxAllowed}. ` +
          'Request fewer fields, reduce the nesting depth, lower the limit argument, ' +
          'or read column statistics with getFieldStats on the columns you display.',
        {
          extensions: {
            code: 'QUERY_COMPLEXITY_EXCEEDED',
            complexity,
            maxAllowed,
            // Refus d'une requête cliente : 400 et non 500 (retiré de la réponse par Apollo)
            http: { status: 400 },
          },
        },
      );
    }

    // Journalisation systématique des scores en mode debug
    if (this.config.MONITORING?.LOG_ALL_METRICS) {
      this.logger.security('Query complexity accepted', {
        requestId: context.requestId,
        operationName,
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
   * Checks disallowed operation names and non-query operation types
   * (mutations and subscriptions are blocked). The text of the query is not
   * pattern-matched: see the note at the top of this module.
   *
   * @param operation - Parsed GraphQL operation definition.
   * @throws {GraphQLError} When the operation fails any validation check.
   */
  validateRequest(operation: GraphQLOperation): void {
    // 1. Validation du nom de l'opération
    const operationName = operation?.name?.value;
    if (operationName && !this.isOperationAllowed(operationName)) {
      throw new GraphQLError(`Operation ${previewValue(operationName)} is not allowed`, {
        extensions: { code: 'OPERATION_NOT_ALLOWED', http: { status: 400 } },
      });
    }

    // 2. Restriction aux requêtes (mutations et subscriptions interdites)
    if (operation?.operation && operation.operation !== 'query') {
      throw new GraphQLError(`Only queries are allowed, got ${operation.operation}`, {
        extensions: { code: 'OPERATION_TYPE_NOT_ALLOWED', http: { status: 400 } },
      });
    }
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
    await Promise.all([this.rateLimiter.cleanup(), this.adminRateLimiter.cleanup()]);
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
export type { GraphQLContext, GraphQLOperation };
