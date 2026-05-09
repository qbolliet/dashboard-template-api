// Importation des types et classes GraphQL
import { GraphQLError } from 'graphql';
import type { GraphQLResolveInfo } from 'graphql';
import { createContextLogger } from '../utils/logger.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryComplexityAnalyzer } from './complexity-analyzer.js';
import { InputSanitizer } from './input-sanitizer.js';
import { PatternValidator } from './pattern-validator.js';
import { config } from '../utils/config-loader.js';
import type { ContextLogger } from '../utils/logger.js';
import type { RateLimitInfo, HttpRequest } from './rate-limiter.js';
import type { SecurityConfig } from '../utils/config-loader.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Extended GraphQL context carrying security-related request information. */
interface GraphQLContext {
    req?:           HttpRequest;
    requestId?:     string;
    rateLimitInfo?: RateLimitInfo;
    [key: string]:  unknown;
}

/** Tracing context attached to security log entries. */
interface SecurityLogContext {
    requestId?:     string;
    operationName:  string;
}

/** Performance and security metrics collected during a resolver execution. */
interface SecurityMetrics {
    executionTime:       number;
    complexity:          number;
    rateLimitRemaining?: number;
    success:             boolean;
}

/** Minimal representation of a GraphQL operation used for validation. */
interface GraphQLOperation {
    name?:       { value?: string };
    operation?:  string;
}

/** Minimal representation of an HTTP request used for document-level validation. */
interface GraphQLRequest {
    query?: string;
}

/** Signature of an original GraphQL resolver function. */
type ResolverFn = (
    root:    unknown,
    args:    Record<string, unknown>,
    context: GraphQLContext,
    info:    GraphQLResolveInfo
) => Promise<unknown> | unknown;

/** Signature of the security middleware function that wraps a resolver. */
type MiddlewareFn = (
    resolve: ResolverFn,
    root:    unknown,
    args:    Record<string, unknown>,
    context: GraphQLContext,
    info:    GraphQLResolveInfo
) => Promise<unknown>;

// ─── Classe gestionnaire de sécurité ────────────────────────────────────────

/**
 * Orchestrates all security modules for GraphQL request processing.
 *
 * Acts as the single coordinator for rate limiting, complexity analysis,
 * input sanitization, and pattern validation. Exposes a middleware factory
 * for integration with Apollo Server's plugin system.
 */
class SecurityManager {
    private config:             SecurityConfig;
    private logger:             ContextLogger;
    private rateLimiter:        RateLimiter;
    private complexityAnalyzer: QueryComplexityAnalyzer;
    private inputSanitizer:     InputSanitizer;
    private patternValidator:   PatternValidator;

    /**
     * Initializes all security sub-modules from the provided configuration.
     *
     * @param securityConfig - Security section of the application configuration.
     */
    constructor(securityConfig: SecurityConfig = config.SECURITY) {
        this.config = securityConfig;
        this.logger = createContextLogger({ component: 'security' });

        // Instanciation des modules de sécurité
        this.rateLimiter        = new RateLimiter(this.config.RATE_LIMIT as unknown as Record<string, unknown>);
        this.complexityAnalyzer = new QueryComplexityAnalyzer(this.config.COMPLEXITY as unknown as Record<string, unknown>);
        this.inputSanitizer     = new InputSanitizer(this.config.SANITIZATION as unknown as Record<string, unknown>);
        this.patternValidator   = new PatternValidator();

        // Journalisation de l'initialisation complète
        this.logger.operation('SecurityManager initialized', {
            modules: ['rateLimiter', 'complexityAnalyzer', 'inputSanitizer', 'patternValidator']
        });
    }

    /**
     * Returns a middleware function that applies all security checks before resolving.
     *
     * The middleware performs (in order): rate limiting, complexity analysis,
     * input sanitization, then delegates to the original resolver. Security
     * metrics are logged after each successful resolution.
     *
     * @returns Async middleware function to wrap GraphQL resolvers.
     */
    createSecurityMiddleware(): MiddlewareFn {
        return async (resolve, root, args, context, info) => {
            // Horodatage de début pour le calcul du temps d'exécution
            const startTime = performance.now();
            const securityContext: SecurityLogContext = {
                requestId:     context.requestId,
                operationName: info?.fieldName ?? 'unknown'
            };

            try {
                // 1. Vérification du rate limit (si la requête HTTP est disponible)
                if (context.req && !this.shouldSkipRateLimit(info)) {
                    const rateLimitInfo      = await this.rateLimiter.checkLimit(context.req);
                    context.rateLimitInfo    = rateLimitInfo;
                }

                // 2. Analyse et vérification de la complexité de la requête
                let complexity = 0;
                if (info?.fieldNodes) {
                    complexity = this.complexityAnalyzer.calculate(info);

                    if (complexity > this.config.COMPLEXITY.MAX_ALLOWED) {
                        throw new GraphQLError('Query too complex', {
                            extensions: {
                                code:       'QUERY_COMPLEXITY_EXCEEDED',
                                complexity,
                                maxAllowed: this.config.COMPLEXITY.MAX_ALLOWED
                            }
                        });
                    }
                }

                // 3. Sanitisation de tous les arguments du resolver
                const sanitizedArgs = this.inputSanitizer.sanitizeAll(args) as Record<string, unknown>;

                // 4. Journalisation du début de l'exécution avec contexte de sécurité
                this.logger.security('Executing resolver with security checks', {
                    ...securityContext,
                    complexity,
                    hasRateLimit: !!context.rateLimitInfo
                });

                // 5. Délégation au resolver original avec les arguments sanitisés
                const result = await resolve(root, sanitizedArgs, context, info);

                // 6. Journalisation des métriques après exécution réussie
                const executionTime = performance.now() - startTime;
                this.logSecurityMetrics(info, {
                    executionTime,
                    complexity,
                    rateLimitRemaining: context.rateLimitInfo?.remaining,
                    success:            true
                });

                return result;

            } catch (error) {
                // Gestion centralisée des erreurs de sécurité
                this.handleSecurityError(error, info, securityContext);
                throw error;
            }
        };
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
        request:   GraphQLRequest,
        context:   GraphQLContext
    ): Promise<void> {
        const validations: Promise<void>[] = [];

        // 1. Validation des patterns dangereux dans la chaîne de requête brute
        if (request.query) {
            validations.push(
                this.patternValidator.validateQuery(request.query)
                    .catch((err: unknown) => {
                        this.logger.security('Pattern validation failed', {
                            error:     (err as Error).message,
                            requestId: context.requestId
                        });
                        throw err;
                    })
            );
        }

        // 2. Validation du nom de l'opération
        const operationName = operation?.name?.value;
        if (operationName && !this.isOperationAllowed(operationName)) {
            throw new GraphQLError(`Operation ${operationName} is not allowed`, {
                extensions: { code: 'OPERATION_NOT_ALLOWED' }
            });
        }

        // 3. Restriction aux requêtes (mutations et subscriptions interdites)
        if (operation?.operation && operation.operation !== 'query') {
            throw new GraphQLError(`Only queries are allowed, got ${operation.operation}`, {
                extensions: { code: 'OPERATION_TYPE_NOT_ALLOWED' }
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
     * Determines whether rate limiting should be skipped for a given field.
     *
     * @param info - GraphQL resolve info (may be undefined).
     * @returns True when rate limiting should be bypassed.
     */
    private shouldSkipRateLimit(info?: GraphQLResolveInfo): boolean {
        // Exemption des champs d'introspection hors production
        if (
            process.env['NODE_ENV'] !== 'production' &&
            (info?.fieldName === '__schema' || info?.fieldName === '__type')
        ) {
            return true;
        }
        return false;
    }

    /**
     * Logs performance and security metrics for a resolved field.
     *
     * Slow queries are always logged; full metrics are logged only when
     * LOG_ALL_METRICS is enabled in the monitoring configuration.
     *
     * @param info - GraphQL resolve info (may be undefined).
     * @param metrics - Execution metrics to record.
     */
    private logSecurityMetrics(
        info:    GraphQLResolveInfo | undefined,
        metrics: SecurityMetrics
    ): void {
        const slowThreshold = this.config.MONITORING?.SLOW_QUERY_THRESHOLD ?? 1000;

        if (metrics.executionTime > slowThreshold) {
            // Journalisation des requêtes dépassant le seuil de lenteur
            this.logger.performance('Slow query detected', {
                field: info?.fieldName,
                ...metrics,
                tags: ['slow-query', 'security']
            });
        }

        // Journalisation complète uniquement en mode debug
        if (this.config.MONITORING?.LOG_ALL_METRICS) {
            this.logger.security('Security metrics', {
                field: info?.fieldName,
                ...metrics
            });
        }
    }

    /**
     * Handles and logs an error raised inside the security middleware.
     *
     * Distinguishes between declared security violations and unexpected errors
     * to route them to the appropriate log level.
     *
     * @param error - The caught error.
     * @param info - GraphQL resolve info (may be undefined).
     * @param context - Security log context for enrichment.
     */
    private handleSecurityError(
        error:   unknown,
        info:    GraphQLResolveInfo | undefined,
        context: SecurityLogContext
    ): void {
        const graphqlError = error as { extensions?: { code?: string } };
        const errorContext = {
            field:     info?.fieldName,
            errorCode: graphqlError.extensions?.code,
            ...context
        };

        // Distinction entre violation de sécurité et erreur interne du middleware
        if (graphqlError.extensions?.code?.startsWith('SECURITY_')) {
            this.logger.security('Security violation', errorContext);
        } else {
            this.logger.error('Security middleware error', error, errorContext);
        }
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
export type {
    GraphQLContext,
    SecurityLogContext,
    SecurityMetrics,
    GraphQLOperation,
    GraphQLRequest
};
