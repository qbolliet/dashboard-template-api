// Importation des modules
import { GraphQLError } from 'graphql';
import { createContextLogger } from '../utils/logger.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryComplexityAnalyzer } from './complexity-analyzer.js';
import { InputSanitizer } from './input-sanitizer.js';
import { PatternValidator } from './pattern-validator.js';
import { config } from '../utils/config-loader.js';


// Gestionnaire de la sécurité
/**
 * Gestionnaire de sécurité principal
 * Coordonne tous les modules de sécurité
 */
class SecurityManager {
    // Initialisation
    constructor(securityConfig = config.SECURITY) {
        this.config = securityConfig;
        this.logger = createContextLogger({ component: 'security' });
        
        // Initialisation des modules
        this.rateLimiter = new RateLimiter(securityConfig.RATE_LIMIT);
        this.complexityAnalyzer = new QueryComplexityAnalyzer(securityConfig.COMPLEXITY);
        this.inputSanitizer = new InputSanitizer(securityConfig.SANITIZATION);
        this.patternValidator = new PatternValidator();
        
        // Logging
        this.logger.security('SecurityManager initialized', {
            modules: ['rateLimiter', 'complexityAnalyzer', 'inputSanitizer', 'patternValidator']
        });
    }

    // Méthode de gestion de la sécurité
    /**
     * Middleware de sécurité pour les resolvers GraphQL
     * @returns {Function} Middleware function
     */
    createSecurityMiddleware() {
        return async (resolve, root, args, context, info) => {
            // Initialisation de l'instant
            const startTime = performance.now();
            const securityContext = {
                requestId: context.requestId,
                operationName: info?.fieldName || 'unknown'
            };

            try {
                // 1. Vérification du rate limit (seulement si req est disponible)
                if (context.req && !this.shouldSkipRateLimit(info)) {
                    const rateLimitInfo = await this.rateLimiter.checkLimit(context.req);
                    context.rateLimitInfo = rateLimitInfo;
                }

                // 2. Analyse de la complexité de la requête
                let complexity = 0;
                if (info && info.fieldNodes) {
                    complexity = this.complexityAnalyzer.calculate(info);
                    
                    // Vérifier si la complexité dépasse la limite
                    if (complexity > this.config.COMPLEXITY.MAX_ALLOWED) {
                        throw new GraphQLError('Query too complex', {
                            extensions: { 
                                code: 'QUERY_COMPLEXITY_EXCEEDED',
                                complexity,
                                maxAllowed: this.config.COMPLEXITY.MAX_ALLOWED
                            }
                        });
                    }
                }

                // 3. Sanitization des arguments
                const sanitizedArgs = this.inputSanitizer.sanitizeAll(args);

                // 4. Log de début d'exécution avec contexte de sécurité
                this.logger.security('Executing resolver with security checks', {
                    ...securityContext,
                    complexity,
                    hasRateLimit: !!context.rateLimitInfo
                });

                // 5. Exécution du resolver
                const result = await resolve(root, sanitizedArgs, context, info);

                // 6. Logging des métriques de sécurité
                const executionTime = performance.now() - startTime;
                this.logSecurityMetrics(info, {
                    executionTime,
                    complexity,
                    rateLimitRemaining: context.rateLimitInfo?.remaining,
                    success: true
                });

                return result;

            } catch (error) {
                // Log de l'erreur avec contexte de sécurité
                this.handleSecurityError(error, info, securityContext);
                throw error;
            }
        };
    }

    // Méthode d evalidation de la requête
    /**
     * Validation au niveau de la requête GraphQL
     * Utilisé dans le plugin Apollo Server
     */
    async validateRequest(operation, request, context) {
        const validations = [];
        
        // 1. Validation des patterns dangereux
        if (request.query) {
            validations.push(
                this.patternValidator.validateQuery(request.query)
                    .catch(err => {
                        this.logger.security('Pattern validation failed', {
                            error: err.message,
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

        // 3. Validation du type d'opération
        if (operation?.operation && operation.operation !== 'query') {
            throw new GraphQLError(`Only queries are allowed, got ${operation.operation}`, {
                extensions: { code: 'OPERATION_TYPE_NOT_ALLOWED' }
            });
        }

        await Promise.all(validations);
    }

    // Méthode de vérification que l'opération est autorisée
    /**
     * Vérifie si une opération est autorisée
     */
    isOperationAllowed(operationName) {
        const allowedOperations = config.ALLOWED_OPERATIONS || [];
        
        // En développement, autoriser l'introspection
        if (process.env.NODE_ENV !== 'production' && operationName === 'IntrospectionQuery') {
            return true;
        }
        
        return allowedOperations.includes(operationName);
    }

    // Méthode déterminant si le rate limiting doit être ignoré
    /**
     * Détermine si le rate limiting doit être ignoré
     */
    shouldSkipRateLimit(info) {
        // Ignorer le rate limiting pour l'introspection en développement
        if (process.env.NODE_ENV !== 'production' && 
            info?.fieldName === '__schema' || info?.fieldName === '__type') {
            return true;
        }
        
        return false;
    }

    // Méthode de logging des métriques de sécurité
    /**
     * Log des métriques de sécurité
     */
    logSecurityMetrics(info, metrics) {
        if (metrics.executionTime > this.config.MONITORING?.SLOW_QUERY_THRESHOLD || 1000) {
            this.logger.performance('Slow query detected', {
                field: info?.fieldName,
                ...metrics,
                tags: ['slow-query', 'security']
            });
        }

        // Log des métriques générales seulement en mode debug
        if (this.config.MONITORING?.LOG_ALL_METRICS) {
            this.logger.security('Security metrics', {
                field: info?.fieldName,
                ...metrics
            });
        }
    }

    // Méthode de gestion centralisée des erreurs de sécurité
    /**
     * Gestion centralisée des erreurs de sécurité
     */
    handleSecurityError(error, info, context) {
        const errorContext = {
            field: info?.fieldName,
            errorCode: error.extensions?.code,
            ...context
        };

        // Log différent selon le type d'erreur
        if (error.extensions?.code?.startsWith('SECURITY_')) {
            this.logger.security('Security violation', errorContext);
        } else {
            this.logger.error('Security middleware error', error, errorContext);
        }
    }

    // Méthode de nettoyage
    /**
     * Méthode pour nettoyer les ressources
     */
    async cleanup() {
        this.logger.security('Cleaning up SecurityManager resources');
        await this.rateLimiter.cleanup();
    }
}

// Singleton pour l'instance globale
let securityManagerInstance = null;

// Fonction d'initialisation du gestionnaire de la sécurité avec la configuration
/**
 * Initialise le SecurityManager avec la configuration
 */
const initializeSecurityManager = (securityConfig) => {
    if (securityManagerInstance) {
        throw new Error('SecurityManager already initialized');
    }
    securityManagerInstance = new SecurityManager(securityConfig);
    return securityManagerInstance;
}

// Fonction créant une instance du gestionnaire de sécurité
/**
 * Récupère l'instance du SecurityManager
 */
const getSecurityManager = () => {
    if (!securityManagerInstance) {
        // Initialisation avec la configuration par défaut si non initialisé
        securityManagerInstance = new SecurityManager();
    }
    return securityManagerInstance;
}

export { SecurityManager , initializeSecurityManager, getSecurityManager};