// Importation des modules
import { ApolloServer } from 'apollo-server-express';
import express from 'express';
import compression from 'compression';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';

// Importation des modules locaux
import { schema } from './schema/index.js';
import { createLoaders } from './loaders/index.js';
import { logger } from './utils/logger.js';
import { closeConnections } from './db/index.js';
import { redis } from './cache/index.js';
import { SecurityManager } from './security/index.js';

// Configuration des chemins avec ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chargement du fichier de configuration
const configPath = path.resolve(__dirname, '../config/config.yaml');
const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));

// Fonction de lancement du server
/**
 * Starts the GraphQL API server with security and performance configurations
 * @returns {Promise<void>}
 */
async function startServer() {
    const app = express();

    // Headers de sécurité
    app.use((req, res, next) => {
        res.set({
            'Access-Control-Allow-Origin': process.env.NODE_ENV === 'production' ? config['DOMAIN'] : 'https://studio.apollographql.com',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
        });
        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }
        next();
    });

    // Gestion de la taille limite des requêtes
    app.use(express.json({
        // Vérifie que la taille de la requête est inférieure à la taille maximale fixée en paramètre
        limit: config['REQUEST_LIMITS']['MAX_REQUEST_SIZE'],
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
                if (fields > config['REQUEST_LIMITS']['MAX_FIELDS']) {
                    throw new Error('Too many fields in request');
                }
        
                // Estimation de la taille de chaque champ
                const checkFieldSize = (obj) => {
                    if (typeof obj === 'object' && obj !== null) {
                        Object.entries(obj).forEach(([key, value]) => {
                            if (typeof value === 'string' && value.length > config['REQUEST_LIMITS']['MAX_FIELD_SIZE']) {
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
        if (config['CACHE']['PUBLIC_PATHS'].some(path => req.path.startsWith(path))) {
            res.set('Cache-Control', `public, max-age=${config['CACHE']['DEFAULT_MAX_AGE']}`);
            res.set('Vary', config['CACHE']['VARY_BY_HEADERS'].join(', '));
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
        // Autorise l'introspection en developpement
        introspection: process.env.NODE_ENV !== 'production',
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
                    // Extraction du nom de l'opération
                    const operationName = node.name?.value;

                    // Ne valide pas les requêtes d'introspection en environnement de développement
                    if (process.env.NODE_ENV !== 'production' && operationName === 'IntrospectionQuery') {
                        return;
                    }
                    // Vérification que l'opération fait bien partie des opérations autorisées
                    if (!config['ALLOWED_OPERATIONS'].includes(operationName)) {
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
                                // Ne vérifie pas le taux des requêtes d'introspection en environnement de développement
                                if (process.env.NODE_ENV !== 'production' && operationName === 'IntrospectionQuery') {
                                    return;
                                }

                                // 1. Vérification si l'opération est permise
                                if (!config['ALLOWED_OPERATIONS'].includes(operationName)) {
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
    
    // Fermeture de la session dans les environnements de développement
    process.on('SIGINT', async () => {
        // Logging
        logger.info('Received SIGINT signal. Starting graceful shutdown...');
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

export { startServer };