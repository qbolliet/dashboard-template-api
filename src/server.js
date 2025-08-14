// Importation des modules
import { ApolloServer } from 'apollo-server-express';
import express from 'express';
import compression from 'compression';
import { v4 as uuidv4 } from 'uuid';

// Importation des modules locaux
import { schema } from './schema/index.js';
import { createLoaders } from './loaders/index.js';
import { logger, createContextLogger } from './utils/logger.js';
import { closeAllConnections, databaseManager } from './db/index.js';
import { redis } from './cache/index.js';
import { initializeSecurityManager } from './security/index.js';
import { createDepthLimitRule } from './security/depth-limit.js';
import { config } from './utils/config-loader.js';
import { createCacheInvalidationRoutes } from './cache/cache-invalidation.js';

// Fonction de lancement du server
/**
 * Starts the GraphQL API server with security and performance configurations
 * @returns {Promise<void>}
 */
async function startServer() {
    const app = express();

    // Headers de sécurité
    app.use((req, res, next) => {
        // Détermine les origines autorisées selon l'environnement
        const allowedOrigins = config.API.CORS.ORIGINS;
        const origin = req.headers.origin;
        
        if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
            res.set('Access-Control-Allow-Origin', origin || '*');
        }
        
        res.set({
            'Access-Control-Allow-Credentials': String(config.API.CORS.CREDENTIALS),
            'Access-Control-Allow-Methods': config.API.CORS.METHODS.join(', '),
            'Access-Control-Allow-Headers': config.API.CORS.HEADERS.join(', '),
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Strict-Transport-Security': `max-age=${config.API.SECURITY_THRESHOLDS.HSTS_MAX_AGE}; includeSubDomains`
        });
        
        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }
        next();
    });

    // Gestion de la taille limite des requêtes
    app.use(express.json({
        // Vérifie que la taille de la requête est inférieure à la taille maximale fixée en paramètre
        limit: config.API.REQUEST_LIMITS.MAX_REQUEST_SIZE,
        verify: (req, res, buf) => {
            // Ne vérifie pas la taille des requêtes pour les requêtes d'introspection
            try {
                const body = JSON.parse(buf.toString());
                if (body.operationName === 'IntrospectionQuery') {
                    return;
                }
        
                // Comptage du nombre de champs
                const countFields = (obj) => {
                    let count = 0;
                    const queue = [obj];
                    
                    while (queue.length > 0) {
                        const current = queue.shift();
                        if (typeof current === 'object' && current !== null) {
                            Object.values(current).forEach(value => {
                                if (typeof value === 'object' && value !== null) {
                                    queue.push(value);
                                }
                                count++;
                            });
                        }
                    }
                    return count;
                };
        
                // Vérification du nombre de champs
                const fields = countFields(body);
                if (fields > config.API.REQUEST_LIMITS.MAX_FIELDS) {
                    throw new Error('Too many fields in request');
                }
        
                // Estimation de la taille de chaque champ
                const checkFieldSize = (obj) => {
                    if (typeof obj === 'object' && obj !== null) {
                        Object.entries(obj).forEach(([key, value]) => {
                            if (typeof value === 'string' && value.length > config.API.REQUEST_LIMITS.MAX_FIELD_SIZE) {
                                throw new Error(`Field ${key} exceeds maximum allowed size`);
                            }
                            if (typeof value === 'object' && value !== null) {
                                checkFieldSize(value);
                            }
                        });
                    }
                };
                // Vérification de la taille des champs
                checkFieldSize(body);
            } catch (error) {
                if (error.message !== 'Unexpected end of JSON input') {
                    throw error;
                }
            }
        }
    }));

    // Compression pour les requêtes les plus importantes
    if (config.API.COMPRESSION.ENABLED) {
        // Ne compresse que les requêtes les plus importantes
        app.use(compression({
            threshold: config.API.COMPRESSION.THRESHOLD,
            level: config.API.COMPRESSION.LEVEL,
            filter: (req, res) => {
                if (req.headers['x-no-compression']) return false;
                return compression.filter(req, res);
            }
        }));
    }

    // Contrôle du cache HTTP
    app.use((req, res, next) => {
        if (config.CACHE.HTTP_CACHE.PUBLIC_PATHS.some(path => req.path.startsWith(path))) {
            res.set('Cache-Control', `public, max-age=${config.CACHE.TTL.DEFAULT}`);
            res.set('Vary', config.CACHE.HTTP_CACHE.VARY_BY_HEADERS.join(', '));
        } else {
            res.set('Cache-Control', 'no-store');
        }
        next();
    });

    // Configuration des routes d'invalidation de cache
    createCacheInvalidationRoutes(app);

    // Création du SecurityManager
    const securityManager = initializeSecurityManager(config.SECURITY);

    // Création du Server Apollo
    const server = new ApolloServer({
        // Schéma de l'API
        schema,
        // Contexte de la requête
        context: async ({ req, res }) => {
            // Extract database routing information
            const headerDatabase = req.headers['x-database-id'];
            
            // Validate database routing if specified
            let validatedDatabase = null;
            if (headerDatabase) {
                try {
                    validatedDatabase = databaseManager.validateDatabaseRouting(null, headerDatabase);
                } catch (error) {
                    logger.warn('Invalid database specified in header', { 
                        requestedDatabase: headerDatabase,
                        error: error.message 
                    });
                    // Continue with default database rather than failing
                }
            }
            
            return {
                requestId: uuidv4(),
                loaders: createLoaders(validatedDatabase), // Create loaders for the specific database
                databaseManager,
                requestDatabase: validatedDatabase, // Store for GraphQL parameter override
                // Helper function to get loaders for a specific database
                getLoadersForDatabase: (databaseId) => {
                    const targetDb = databaseManager.validateDatabaseRouting(databaseId, validatedDatabase);
                    return targetDb === validatedDatabase ? null : createLoaders(targetDb);
                },
                req,
                res
            };
        },
        // Autorise l'introspection en developpement
        introspection: config.API.GRAPHQL.INTROSPECTION,
        // Formattage des erreurs
        formatError: (err) => {
            // Création d'un identifiant associé à l'erreur
            const errorId = uuidv4();
            // Logging de l'erreur
            logger.error(`Error [${errorId}]: ${err.message}`, {
                stack: err.stack,
            });
            // Distinction de message d'erreur suivant que l'on se situe en production ou non
            const isProduction = config.ENVIRONMENT === 'production';
            return {
                message: isProduction ? 'An error occurred' : err.message,
                code: err.extensions?.code || 'INTERNAL_SERVER_ERROR',
                errorId,
            };
        },
        // Règles de validation de la requête
        validationRules: [
            // Vérification de la règle de profondeur
            createDepthLimitRule(config.SECURITY?.MAX_QUERY_DEPTH || config.SECURITY?.SECURITY_LIMITS?.DEFAULT_DEPTH_LIMIT || 5),
            // Liste blanche des opérations valides
            (context) => ({
                OperationDefinition(node) {
                    // Extraction du nom de l'opération
                    const operationName = node.name?.value;

                    // Ne valide pas les requêtes d'introspection en environnement de développement
                    if (config.ENVIRONMENT !== 'production' && operationName === 'IntrospectionQuery') {
                        return;
                    }

                    // Toutes les opérations sont autorisées par défaut
                    // La sécurité est gérée par les pattern validators
                    return true;
                    // Vérification que l'opération fait bien partie des opérations autorisées
                    // const allowedOps = config.ALLOWED_OPERATIONS;
                    // if (allowedOps && allowedOps.length > 0 && operationName && !allowedOps.includes(operationName)) {
                    //     throw new Error(`Operation ${operationName} is not allowed`);
                    // }
                }
            })
        ],
        // Security is handled via plugins and validation rules
        // Plug-ins
        plugins: [
            {
                // Plugin du cycle de vie de la requête
                requestDidStart({request, context}) {
                    const requestStart = Date.now();

                    const contextLogger = createContextLogger({
                        requestId: context.requestId,
                        operationName: request.operationName
                    });
                    
                    return {
                        // Validation de la requête avant son analyse
                        async didResolveOperation({operation}) {
                            // Validation de la requête à l'aide du SecurityManager
                             try {
                                await securityManager.validateRequest(operation, request, context);
                            } catch (error) {
                                throw error;
                            }
                        },
                        
                        // Logging de la complétion de la requête
                        willSendResponse({response}) {
                            const duration = Date.now() - requestStart;
                            const metrics = {
                                duration,
                                errors: response.errors?.length || 0
                            };
                            
                            contextLogger.performance('Request completed', metrics);
                        },
                        
                        // Logging de rencontre d'erreurs éventuelles
                        didEncounterErrors({errors}) {
                            errors.forEach(error => {
                                contextLogger.error('GraphQL error', error, {
                                    path: error.path,
                                    locations: error.locations
                                });
                            });
                        }
                    };
                }
            }
        ],
        
        // Formattage de l'erreur en production
        formatResponse: (response, { context }) => {
            // Log des erreurs en production
            if (response.errors && config.ENVIRONMENT === 'production') {
                response.errors = response.errors.map(error => ({
                    message: 'An error occurred',
                    errorId: error.extensions?.errorId,
                    code: error.extensions?.code
                }));
            }
            return response;
        }
    });

    // Ajout du middleware de gestion des erreurs qui reprend le formattage dans Apollo server
    app.use((err, req, res, next) => {
        // Création d'un identiant unique associé à l'erreur
        const errorId = uuidv4();
        // Logging de l'erreur
        logger.error('Unexpected error:', {
            error: err,
            errorId,
            requestId: req.requestId
        });
        // Distinction du message d'erreur suivant que l'on se trouve ou non dans un environnement de production
        const isProduction = config.ENVIRONMENT === 'production';
        res.status(err.status || 500).json({
            error: isProduction ? 'Internal server error' : err.message,
            errorId,
            requestId: req.requestId
        });
    });

    // Gestion de la fermeture gracieuse
    const gracefulShutdown = async (signal) => {
        // Logging
        logger.info(`Received ${signal} signal. Starting graceful shutdown...`);
        // Fermeture de l'ensemble des connexions
        try {
            await Promise.all([
                // Fermeture du cache
                redis.quit(),
                /// Fermeture des connexions
                closeAllConnections(),
                // Fermeture du gestionnaire de sécurité
                securityManager.cleanup(),
                // Fermeture du serveur
                new Promise((resolve) => server.stop().then(resolve))
            ]);
            // Logging
            logger.info('Graceful shutdown completed');
            // Fin
            process.exit(0);
        } catch (error) {
            // Logging
            logger.error('Error during graceful shutdown:', error);
            // Fin
            process.exit(1);
        }
    };
    
    // Fermeture de la session
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    // Fermeture de la session dans les environnements de développement
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Lancement du serveur
    await server.start();
    // Application du Middleware configuré avec express
    server.applyMiddleware({ app });
    // Initialisation du port
    const port = process.env.PORT || 4000;
    app.listen(port, () => {
        logger.info(`🚀 Server ready at http://localhost:${port}${server.graphqlPath}`);
        logger.info(`🌍 Environment: ${config.ENVIRONMENT}`);
        logger.info(`📊 GraphQL Playground: ${config.API.GRAPHQL.PLAYGROUND ? 'enabled' : 'disabled'}`);
    });
}

export { startServer };