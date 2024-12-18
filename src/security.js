// Importation des modules
const { GraphQLError } = require('graphql');
const validator = require('validator');
const sqlstring = require('sqlstring');
const xss = require('xss');
const { performance } = require('perf_hooks');

// Modules ad hoc
const { logger } = require("./utils/logger");

// Ligne 82, ajouter des règles de validation spécifiques aux tableaux

// Gestion de la sécurité
class SecurityManager {

    // Validation des input
    static validateInput(input, validationRules = {}) {
        // Initialisation des règles par défaut
        const defaultRules = {
            type: 'string',
            required: false,
            minLength: 0,
            maxLength: 500,
            pattern: null,
            whitelist: null,
            blacklist: null,
            customValidation: null
        };
        // Initialisation des règles de validation
        const rules = { ...defaultRules, ...validationRules };

        // Gestion de cas où l'input n'est pas renseigné
        if (input === null || input === undefined) {
            if (rules.required) {
                throw new GraphQLError('Input is required', {
                    extensions: { code: 'VALIDATION_ERROR' }
                });
            }
            return input;
        }

        // Vérification du type
        const inputType = Array.isArray(input) ? 'array' : typeof input;
        if (inputType !== rules.type) {
            throw new GraphQLError(`Invalid input type. Expected ${rules.type}, got ${inputType}`, {
                extensions: { code: 'TYPE_MISMATCH' }
            });
        }

        // Validation des strings
        if (rules.type === 'string') {
            // Validation de la longueur
            if (input.length < rules.minLength) {
                throw new GraphQLError(`Input too short. Minimum length is ${rules.minLength}`, {
                    extensions: { code: 'LENGTH_ERROR' }
                });
            }

            if (input.length > rules.maxLength) {
                throw new GraphQLError(`Input too long. Maximum length is ${rules.maxLength}`, {
                    extensions: { code: 'LENGTH_ERROR' }
                });
            }

            // Validation des patterns
            if (rules.pattern && !rules.pattern.test(input)) {
                throw new GraphQLError('Input does not match required pattern', {
                    extensions: { code: 'PATTERN_MISMATCH' }
                });
            }

            // Validation des strings autorisées
            if (rules.whitelist && !rules.whitelist.includes(input)) {
                throw new GraphQLError('Input not in allowed values', {
                    extensions: { code: 'WHITELIST_ERROR' }
                });
            }

            // Validation des strings interdites
            if (rules.blacklist && rules.blacklist.includes(input)) {
                throw new GraphQLError('Input contains disallowed value', {
                    extensions: { code: 'BLACKLIST_ERROR' }
                });
            }
        }

        // Validation des tableaux
        if (rules.type === 'array') {
            // Additional array validations can be added here
        }

        // Validation spécifique
        if (rules.customValidation) {
            const customValidationResult = rules.customValidation(input);
            if (customValidationResult !== true) {
                throw new GraphQLError(customValidationResult || 'Custom validation failed', {
                    extensions: { code: 'CUSTOM_VALIDATION_ERROR' }
                });
            }
        }

        return input;
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

            // SUppression des anciennes entrées
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

    // Gestion de la performance et de la sécurité
    static createPerformanceMonitor() {
        return async (resolve, root, args, context, info) => {
            const start = performance.now();

            try {
                // Vérification et validation des arguments en entrée
                const sanitizedArgs = Object.entries(args).reduce((acc, [key, value]) => {
                    acc[key] = this.sanitizeXSS(
                        this.preventSQLInjection(
                            this.validateInput(value)
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

module.exports = { SecurityManager };