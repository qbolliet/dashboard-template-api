// Importation des modules
const { ApolloServer } = require('apollo-server-express');
const express = require('express');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const { schema } = require('./schema');
const { createLoaders } = require('./loaders');
const { logger } = require('./utils/logger');
const { closeConnections } = require('./db');
const { redis } = require('./cache');

// Liste des requêtes permises
const ALLOWED_OPERATIONS = new Set([
    'getMetaData',
    'getDimensionTable',
    'getFactTable',
    'getAggregatedFacts',
    'getSelectOptions',
    'getGroupedSelectOptions'
]);

// Configuration de la taille maximale des requêtes
const REQUEST_LIMITS = {
    maxRequestSize: '100kb',
    maxFieldSize: 1000,
    maxFields: 50
};

// Configuration du cache
const CACHE_CONFIG = {
    defaultMaxAge: 300, // 5 minutes
    publicPaths: ['/graphql'],
    varyByHeaders: ['accept-encoding', 'accept']
};

// Fonction de lancement du serveur
async function startServer() {
    const app = express();

    // Headers de sécurité
    app.use((req, res, next) => {
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
        });
        next();
    });

    // Gestion de la taille limite des requêtes
    app.use(express.json({
        limit: REQUEST_LIMITS.maxRequestSize,
        verify: (req, res, buf) => {
            if (buf.length > parseInt(REQUEST_LIMITS.maxRequestSize)) {
                throw new Error('Request entity too large');
            }
        }
    }));

    // Compression pour les requêtes les plus importantes
    app.use(compression({
        threshold: 1024, // Compresse seulement les réponses de plus de 1 kB
        filter: (req, res) => {
            // Ne compresse pas les réponses pour les navigateurs les plus anciens
            if (req.headers['x-no-compression']) return false;
            return compression.filter(req, res);
        },
        level: 6 // Niveau de compression équilibré
    }));

    // Contrôle du cache
    app.use((req, res, next) => {
        if (CACHE_CONFIG.publicPaths.some(path => req.path.startsWith(path))) {
            res.set('Cache-Control', `public, max-age=${CACHE_CONFIG.defaultMaxAge}`);
            res.set('Vary', CACHE_CONFIG.varyByHeaders.join(', '));
        } else {
            res.set('Cache-Control', 'no-store');
        }
        next();
    });

    // Création du Server Apollo
    const server = new ApolloServer({
        // Schéma de l'API
        schema,
        // Contexte de la requête
        context: async ({ req, res }) => ({
            requestId: uuidv4(),
            loaders: createLoaders(),
            req,
            res
        }),
        // Formattage des erreurs
        formatError: (err) => {
            // Création d'un identifiant associé à l'erreur
            const errorId = uuidv4();
            // Logging de l'erreur
            logger.error(`Error [${errorId}]: ${err.message}`, {
                stack: err.stack,
            });
            // Distinction de message d'erreur suivant que l'on se situe en production ou non
            return {
                message: process.env.NODE_ENV === 'production' 
                    ? 'An error occurred' 
                    : err.message,
                code: err.extensions?.code || 'INTERNAL_SERVER_ERROR',
                errorId,
            };
        },
        // Règles de validation de la requête
        validationRules: [
            // Liste blanche des opérations valides
            (context) => ({
                OperationDefinition(node) {
                    const operationName = node.name?.value;
                    if (!ALLOWED_OPERATIONS.has(operationName)) {
                        throw new Error(`Operation ${operationName || 'anonymous'} is not allowed`);
                    }
                }
            })
        ],
        plugins: [
            {
                // Plugin du cycle de vie de la requête
                requestDidStart({request, context}) {
                    const requestStart = Date.now();
                    
                    return {
                        // Validation de la requête avant son analyse
                        async didResolveOperation({operation}) {
                            // Extraction du nom de l'opération
                            const operationName = operation?.name?.value;
                            try {
                                // 1. Vérification si l'opération est permise
                                if (!ALLOWED_OPERATIONS.has(operationName)) {
                                    throw new Error(`Operation ${operationName || 'anonymous'} is not allowed`);
                                }
            
                                // 2. Application de la limite de taux
                                await SecurityManager.createRateLimiter()(context, () => true);
                            } catch (error) {
                                // Gestion unifiée de l'erreur
                                logger.warn('Request validation failed', {
                                    operationName,
                                    errorMessage: error.message
                                });
                                throw error;
                            }
                        },
                        
                        // Logging de la complétion de la requête
                        willSendResponse({response}) {
                            const requestDuration = Date.now() - requestStart;
                            logger.info('Request completed', {
                                duration: requestDuration,
                                operationName: request.operationName,
                                requestId: context.requestId
                            });
                        }
                    };
                }
            }
        ],
        // Monitoring de la performance pour les resolvers
        fieldResolver: SecurityManager.createPerformanceMonitor(),
        // Formattage de l'erreur en production
        formatResponse: (response, { context }) => {
            if (response.errors) {
                // Log errors but sanitize response in production
                if (process.env.NODE_ENV === 'production') {
                    response.errors = response.errors.map(error => ({
                        message: 'An error occurred',
                        errorId: error.extensions?.errorId,
                        code: error.extensions?.code
                    }));
                }
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
        res.status(err.status || 500).json({
            error: process.env.NODE_ENV === 'production' 
                ? 'Internal server error' 
                : err.message,
            errorId,
            requestId: req.requestId
        });
    });

    // Fermeture de la session
    process.on('SIGTERM', async () => {
        // Logging
        logger.info('Received SIGTERM signal. Starting graceful shutdown...');
        // Fermeture de l'ensemble des connexions
        try {
            await Promise.all([
                redis.quit(),
                closeConnections(),
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
    });

    // Lancement du serveur
    await server.start();
    // Application du Middleware configuré avec express
    server.applyMiddleware({ app });
    // Initialisation du port
    const port = process.env.PORT || 4000;
    app.listen(port, () => {
        logger.info(`🚀 Server ready at http://localhost:${port}${server.graphqlPath}`);
    });
}

exports.startServer = startServer;