// Importation des modules
const { GraphQLError } = require('graphql');
const sqlstring = require('sqlstring');
const xss = require('xss');
const { validateInput } = require('./validation');
const { logger } = require('../utils/logger');
const { performance } = require('perf_hooks');

// Gestionnaire de la sécurité
class SecurityManager {
    static async validateRequest(context, info) {
    // Add request validation logic here
    // E.g. rate limiting, etc.
        return true;
    }

    // Rate Limiting Middleware
    static createRateLimiter(options = {}) {
        // Options par défaut
        const {
            maxRequests = 100,
            windowMs = 15 * 60 * 1000, // 15 minutes
            keyGenerator = (context) => context.ip
        } = options;

        const requestLog = new Map();

        return (context, next) => {
            const key = keyGenerator(context);
            const now = Date.now();

            // Suppression des anciennes entrées
            for (const [k, entry] of requestLog.entries()) {
                if (now - entry.timestamp > windowMs) {
                    requestLog.delete(k);
                }
            }

            // Vérification du respect de la fréquence limite
            const userRequests = requestLog.get(key) || { count: 0, timestamp: now };
            
            if (userRequests.count >= maxRequests) {
                throw new GraphQLError('Too many requests, please try again later', {
                    extensions: { 
                        code: 'RATE_LIMIT_EXCEEDED',
                        retryAfter: Math.ceil((windowMs - (now - userRequests.timestamp)) / 1000)
                    }
                });
            }

            // Mise à jour du compteur de requêtes
            requestLog.set(key, {
                count: userRequests.count + 1,
                timestamp: now
            });

            return next();
        };
    }

    // Gestion des injections SQL
    static preventSQLInjection(input) {
        if (typeof input !== 'string') return input;
        
        // Utilisation des requêtes paramétrées pour éviter les caractères spéciaux
        return sqlstring.escape(input);
    }

    // Protection XSS 
    static sanitizeXSS(input) {
        if (typeof input !== 'string') return input;
        
        return xss(input, {
            whiteList: {}, // Suppression des tous les tags HTML
            stripIgnoreTag: true,
            stripIgnoreTagBody: ['script']
        });
    }

    // Gestion de la performance et de la sécurité
    static createPerformanceMonitor() {
        return async (resolve, root, args, context, info) => {
            const start = performance.now();

            try {
                // Vérification et validation des arguments en entrée
                const sanitizedArgs = Object.entries(args).reduce((acc, [key, value]) => {
                    acc[key] = this.sanitizeXSS(
                        this.preventSQLInjection(
                            validateInput(value)
                        )
                    );
                    return acc;
                }, {});

                // Exécution du resolver
                const result = await resolve(root, sanitizedArgs, context, info);

                const end = performance.now();
                const executionTime = end - start;

                // Affiche la performance si le temps d'exécution dépasse un certain seuil
                if (executionTime > 1000) { // 1 second
                    logger.warn(`Slow query detected`, {
                        field: info.fieldName,
                        executionTime,
                        args: sanitizedArgs
                    });
                }

                return result;
            } catch (error) {
                // Retour d'une erreur
                logger.error('GraphQL Error', {
                    error: error.message,
                    stack: error.stack,
                    field: info.fieldName
                });

                throw error;
            }
        };
    }
}

module.exports = SecurityManager;