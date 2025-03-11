// Importation des modules
const { GraphQLError } = require('graphql');
const sqlstring = require('sqlstring');
const xss = require('xss');
const { validateInput } = require('./validation');
const { logger } = require('../utils/logger');
const { performance } = require('perf_hooks');
const crypto = require('crypto');

// Gestionnaire de la sécurité
// /!\ Le rate limiter n'est actuellement pas inclu dans le performance Monitor
class SecurityManager {
    // Initialisation du registre des requêtes
    static requestStore = new Map();

    // Initialisation du coût par défaut des différentes opérations
    static complexityScores = {
        query: 1,
        aggregation: 2,
        sort: 0.5,
        filter: 0.5
    };

    static async validateRequest(context, info) {
        // Add request validation logic here
        // E.g. user authentification
        return true;
    }

    // Rate Limiting Middleware
    static createRateLimiter(options = {}) {
        // Extraction du requestStore
        const store = SecurityManager.requestStore;

        // Options par défaut
        const {
            maxRequests = 100,
            windowMs = 15 * 60 * 1000, // 15 minutes
            maxBurstRequests = 20, // Nombre de requête maximal par période
            burstWindowMs = 60 * 1000, // Durée de la période (1 minute)
        } = options;

        return (context, next) => {
            // Extraction de l'agent et de l'IP
            const clientIp = context.req.ip || context.req.headers['x-forwarded-for'];
            const userAgent = context.req.headers['user-agent'] || 'unknown';

            // Création d'un identifiant unique à partir de ces éléments
            const identifier = crypto
                .createHash('sha256')
                .update(`${clientIp}:${userAgent}`)
                .digest('hex');
            
            // Initialisation de la date
            const now = Date.now();
            // Extraction des données de requêtes
            const requestData = store.get(identifier) || {
                requests: [],
                burstCount: 0,
                lastBurstReset: now
            };

            // Suppression des anciennes requêtes
            requestData.requests = requestData.requests.filter(time => now - time < windowMs);

            // Réinitialisation du compteur si la période a expiré
            if (now - requestData.lastBurstReset > burstWindowMs) {
                requestData.burstCount = 0;
                requestData.lastBurstReset = now;
            }

            // Vérification du respect de la fréquence limite
            if (
                requestData.requests.length >= maxRequests ||
                requestData.burstCount >= maxBurstRequests
            ) {
                logger.warn(`Rate limit exceeded for ${identifier}`);
                throw new GraphQLError('Rate limit exceeded', {
                    extensions: {
                        code: 'RATE_LIMIT_EXCEEDED',
                        retryAfter: Math.ceil((windowMs - (now - requestData.requests[0])) / 1000)
                    }
                });
            }

            // Mise à jour du compteur de requêtes
            requestData.requests.push(now);
            requestData.burstCount++;
            store.set(identifier, requestData);

            return next();
        };
    }

    // Analyse de la complexité des requêtes
    static calculateQueryComplexity(info) {
        // Calcul de la complexité
        const complexity = SecurityManager._recursiveComplexityCalculation(info.fieldNodes[0]);
        
        // Lance une erreur si la requête est excessivement complexe
        if (complexity > 100) { // Seuil arbitraire
            throw new GraphQLError('Query too complex', {
                extensions: { code: 'QUERY_COMPLEXITY_EXCEEDED' }
            });
        }
        
        return complexity;
    }

    // Calcul récursif de la complexité des opérations de la requête
    static _recursiveComplexityCalculation(node, depth = 0) {
        // Initialisation de la complexité
        let complexity = SecurityManager.complexityScores[node.kind] || 1;
        
        // Ajout du coût associé à chaque argument
        if (node.arguments) {
            node.arguments.forEach(arg => {
                if (arg.name.value === 'filter') complexity += this.complexityScores.filter;
                if (arg.name.value === 'sort') complexity += this.complexityScores.sort;
            });
        }
        
        // Multipllication par un facteur de profondeur
        complexity *= (1 + depth * 0.1);
        
        return complexity;
    }

    // Gestion des injections SQL
    static preventSQLInjection(input) {
        if (typeof input !== 'string') return input;

        // Suppression des commentaires
        input = input.replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '');
        
        // Gestion des attaques UNION
        if (/\bunion\b/i.test(input)) {
            throw new GraphQLError('Invalid SQL query', {
                extensions: { code: 'SQL_INJECTION_PREVENTED' }
            });
        }
        
        // Utilisation des requêtes paramétrées pour éviter les caractères spéciaux
        return sqlstring.escape(input);
    }

    

    // Gestion de la performance et de la sécurité
    static createPerformanceMonitor() {
        return async (resolve, root, args, context, info) => {
            // Initialisation du début de l'exécution
            const start = performance.now();

            try {

                // Ignore le calcul de complexité si info n'a pas d'argument fieldNodes
                if (!info || !info.fieldNodes) {
                    // Exécution du resolver seul
                    const result = await resolve(root, args, context, info);
                    return result;
                }
                
                // Calcul de la complexité
                const queryComplexity = this.calculateQueryComplexity(info);
                // Validation de la requête
                await this.validateRequest(context, info);

                // Vérification des arguments
                const sanitizedArgs = this._sanitizeInputs(args);

                // Résolution de la requête
                const result = await resolve(root, sanitizedArgs, context, info);

                // Monitoring de la performance
                const executionTime = performance.now() - start;
                this._logPerformanceMetrics(info, executionTime, queryComplexity);

                return result;
            } catch (error) {
                if (info && info.fieldName) {
                    this._handleError(error, info);
                } else {
                    console.error('GraphQL Error:', error.message);
                }
                throw error;
            }
        };
    }

    // Méthodes auxiliaires
    static _sanitizeInputs(args) {
        return Object.entries(args).reduce((acc, [key, value]) => {
            acc[key] = this.sanitizeXSS(
                    this.preventSQLInjection(
                        validateInput(value)
                    )
                );

            return acc;
        }, {});
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

    // Log des performances
    static _logPerformanceMetrics(info, executionTime, complexity) {
        // Warning si le temps d'exécution excède un certain seuil
        if (executionTime > 1000) { // Seuil arbitraire de 1000 ms
            logger.warn('Slow query detected', {
                field: info.fieldName,
                executionTime,
                complexity
            });
        }
    }

    // Gestion des erreurs
    static _handleError(error, info) {
        logger.error('GraphQL Error', {
            error: error.message,
            stack: error.stack,
            field: info.fieldName
        });
    }    
}

module.exports = { SecurityManager };