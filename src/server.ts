// Importation des modules
import { ApolloServer } from '@apollo/server';
import type { ApolloServerPlugin, GraphQLRequestContext, GraphQLRequestListener } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import { v4 as uuidv4 } from 'uuid';
import type { GraphQLFormattedError } from 'graphql';

// Importation des modules locaux
import { schema } from './schema/index.js';
import { createLoaders } from './loaders/index.js';
import type { LoadersCollection } from './loaders/index.js';
import { logger, createContextLogger } from './utils/logger.js';
import { closeAllConnections, databaseManager } from './db/index.js';
import { redis } from './cache/index.js';
import { initializeSecurityManager } from './security/index.js';
import { createDepthLimitRule } from './security/depth-limit.js';
import { config } from './utils/config-loader.js';
import { createCacheInvalidationRoutes } from './cache/cache-invalidation.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Operational metrics collected over the server's lifetime. */
interface ServerMetrics {
    startedAt: string;
    requests: {
        total: number;
        errors: number;
    };
    responseTimes: number[];
    maxStoredTimes: number;
}

/** Apollo Server context injected into every resolver and plugin. */
interface ServerContext {
    requestId: string;
    loaders: LoadersCollection;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    databaseManager: any;
    requestDatabase: string | null;
    getLoadersForDatabase: (databaseId: string | null) => LoadersCollection | null;
    req: Request;
    res: Response;
    [key: string]: unknown;
}

/** Express error enriched with an optional HTTP status code. */
interface ExpressError extends Error {
    status?: number;
}

/** Apollo response body shape used to access errors in willSendResponse. */
interface MutableSingleResult {
    singleResult?: {
        errors?: GraphQLFormattedError[];
    };
}

/**
 * Starts the GraphQL API server with security and performance configurations.
 *
 * Configures Express middleware (CORS, request limits, compression, HTTP cache),
 * registers health/readiness/metrics endpoints, sets up Apollo Server with
 * security rules and plugins, then begins listening on the configured port.
 *
 * @returns A promise that resolves once the server is listening.
 */
async function startServer(): Promise<void> {
    const app = express();

    // En-têtes de sécurité et configuration CORS
    app.use((req: Request, res: Response, next: NextFunction): void => {
        // Détermination des origines autorisées selon l'environnement
        const allowedOrigins: string[] = config.API.CORS.ORIGINS;
        const origin = req.headers.origin;

        if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
            res.set('Access-Control-Allow-Origin', origin);
        } else if (allowedOrigins.includes('*')) {
            res.set('Access-Control-Allow-Origin', '*');
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
            res.sendStatus(204);
            return;
        }
        next();
    });

    // Gestion de la taille limite des requêtes
    app.use(express.json({
        // Vérification que la taille de la requête est inférieure à la taille maximale fixée en paramètre
        limit: config.API.REQUEST_LIMITS.MAX_REQUEST_SIZE,
        verify: (req: Request, _res: Response, buf: Buffer): void => {
            // Exclusion des requêtes d'introspection de la vérification
            try {
                const body = JSON.parse(buf.toString()) as Record<string, unknown>;
                if (body['operationName'] === 'IntrospectionQuery') {
                    return;
                }

                // Comptage récursif du nombre de champs de l'objet
                const countFields = (obj: unknown): number => {
                    let count = 0;
                    const queue: unknown[] = [obj];

                    while (queue.length > 0) {
                        const current = queue.shift();
                        if (typeof current === 'object' && current !== null) {
                            Object.values(current as Record<string, unknown>).forEach(value => {
                                if (typeof value === 'object' && value !== null) {
                                    queue.push(value);
                                }
                                count++;
                            });
                        }
                    }
                    return count;
                };

                // Vérification du nombre de champs par rapport au maximum autorisé
                const fields = countFields(body);
                if (fields > config.API.REQUEST_LIMITS.MAX_FIELDS) {
                    throw new Error('Too many fields in request');
                }

                // Estimation récursive de la taille de chaque champ
                const checkFieldSize = (obj: unknown): void => {
                    if (typeof obj === 'object' && obj !== null) {
                        Object.entries(obj as Record<string, unknown>).forEach(([key, value]) => {
                            if (typeof value === 'string' && value.length > config.API.REQUEST_LIMITS.MAX_FIELD_SIZE) {
                                throw new Error(`Field ${key} exceeds maximum allowed size`);
                            }
                            if (typeof value === 'object' && value !== null) {
                                checkFieldSize(value);
                            }
                        });
                    }
                };
                // Vérification de la taille de chaque champ
                checkFieldSize(body);
            } catch (error) {
                if ((error as Error).message !== 'Unexpected end of JSON input') {
                    throw error;
                }
            }
        }
    }));

    // Compression des réponses volumineuses
    if (config.API.COMPRESSION.ENABLED) {
        // Application sélective de la compression selon les en-têtes de la requête
        app.use(compression({
            threshold: config.API.COMPRESSION.THRESHOLD,
            level: config.API.COMPRESSION.LEVEL,
            filter: (req: Request, res: Response): boolean => {
                if (req.headers['x-no-compression']) return false;
                return compression.filter(req, res);
            }
        }));
    }

    // Contrôle du cache HTTP selon le chemin de la requête
    app.use((req: Request, res: Response, next: NextFunction): void => {
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

    // Compteurs de métriques en mémoire
    const metrics: ServerMetrics = {
        startedAt: new Date().toISOString(),
        requests: { total: 0, errors: 0 },
        responseTimes: [],
        maxStoredTimes: 1000
    };

    // GET /health — vérification de la disponibilité du serveur
    app.get('/health', (_req: Request, res: Response): void => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: config.ENVIRONMENT
        });
    });

    // GET /ready — vérification des dépendances (pool DB + Redis)
    app.get('/ready', async (_req: Request, res: Response): Promise<void> => {
        const checks: Record<string, { status: string; pool?: unknown; message?: string }> = {};
        let allOk = true;

        // Vérification du pool DuckDB
        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            const stats = databaseManager.getStatistics() as { sharedPool: unknown };
            checks['database'] = { status: 'ok', pool: stats.sharedPool };
        } catch (err) {
            checks['database'] = { status: 'error', message: (err as Error).message };
            allOk = false;
        }

        // Vérification de la connexion Redis
        try {
            await redis.ping();
            checks['redis'] = { status: 'ok' };
        } catch (err) {
            checks['redis'] = { status: 'error', message: (err as Error).message };
            allOk = false;
        }

        res.status(allOk ? 200 : 503).json({
            status: allOk ? 'ready' : 'not_ready',
            timestamp: new Date().toISOString(),
            checks
        });
    });

    // GET /metrics — métriques opérationnelles légères
    app.get('/metrics', (_req: Request, res: Response): void => {
        const times = metrics.responseTimes;
        const avg = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
        const sorted = [...times].sort((a, b) => a - b);
        const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;
        const p99 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] : 0;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const dbStats = databaseManager.getStatistics() as { sharedPool: unknown };

        res.json({
            startedAt: metrics.startedAt,
            uptime: process.uptime(),
            requests: {
                total: metrics.requests.total,
                errors: metrics.requests.errors,
                errorRate: metrics.requests.total > 0
                    ? (metrics.requests.errors / metrics.requests.total).toFixed(4)
                    : '0'
            },
            responseTime: { avg, p95, p99, samples: times.length },
            database: dbStats.sharedPool,
            memory: process.memoryUsage()
        });
    });

    // Création du gestionnaire de sécurité
    const securityManager = initializeSecurityManager(config.SECURITY);

    // Définition du plugin de cycle de vie des requêtes Apollo
    const requestLifecyclePlugin: ApolloServerPlugin<ServerContext> = {
        async requestDidStart(
            { request, contextValue }: GraphQLRequestContext<ServerContext>
        ): Promise<GraphQLRequestListener<ServerContext>> {
            const requestStart = Date.now();

            const contextLogger = createContextLogger({
                requestId: contextValue?.requestId,
                operationName: request.operationName ?? undefined
            });

            metrics.requests.total++;

            return {
                // Validation de sécurité avant l'exécution de l'opération
                async didResolveOperation({ operation, request: opRequest }): Promise<void> {
                    try {
                        await securityManager.validateRequest(
                            operation as { name?: { value?: string }; operation?: string },
                            opRequest as { query?: string },
                            contextValue
                        );
                    } catch (error) {
                        throw error;
                    }
                },

                // Logging de la complétion de la requête et formatage en production
                async willSendResponse({ response }): Promise<void> {
                    const duration = Date.now() - requestStart;
                    const mutableBody = response.body as MutableSingleResult;
                    const errors = mutableBody.singleResult?.errors;

                    contextLogger.performance('Request completed', {
                        duration,
                        errors: errors?.length ?? 0
                    });

                    // Mise à jour des compteurs de métriques
                    if (errors && errors.length > 0) metrics.requests.errors++;
                    metrics.responseTimes.push(duration);
                    if (metrics.responseTimes.length > metrics.maxStoredTimes) {
                        metrics.responseTimes.shift();
                    }

                    // Masquage des messages d'erreur détaillés en production
                    if (errors && config.ENVIRONMENT === 'production' && mutableBody.singleResult) {
                        mutableBody.singleResult.errors = errors.map(error => ({
                            message: 'An error occurred',
                            extensions: {
                                errorId: error.extensions?.['errorId'] as string | undefined,
                                code: error.extensions?.['code'] as string | undefined
                            }
                        }));
                    }
                },

                // Logging des erreurs GraphQL rencontrées lors de la résolution
                async didEncounterErrors({ errors: graphqlErrors }): Promise<void> {
                    graphqlErrors.forEach(error => {
                        contextLogger.error('GraphQL error', error, {
                            path: error.path,
                            locations: error.locations
                        });
                    });
                }
            };
        }
    };

    // Création du serveur Apollo
    const server = new ApolloServer<ServerContext>({
        // Schéma exécutable de l'API
        schema,
        // Autorisation de l'introspection en développement
        introspection: config.API.GRAPHQL.INTROSPECTION,
        // Formatage des erreurs avec identifiant unique de traçabilité
        formatError: (formattedError, error) => {
            // Génération d'un identifiant unique associé à l'erreur
            const errorId = uuidv4();
            logger.error(`Error [${errorId}]: ${formattedError.message}`, {
                stack: (error as Error)?.stack,
            });
            // Distinction du message d'erreur selon l'environnement
            const isProduction = config.ENVIRONMENT === 'production';
            return {
                message: isProduction ? 'An error occurred' : formattedError.message,
                extensions: {
                    code: formattedError.extensions?.['code'] ?? 'INTERNAL_SERVER_ERROR',
                    errorId,
                }
            };
        },
        // Règles de validation des requêtes entrantes
        validationRules: [
            // Règle de limitation de la profondeur des requêtes
            createDepthLimitRule(
                config.SECURITY?.MAX_QUERY_DEPTH
                ?? config.SECURITY_LIMITS?.DEFAULT_DEPTH_LIMIT
                ?? 5
            ),
            // Liste blanche des opérations valides
            () => ({
                OperationDefinition(node) {
                    // Extraction du nom de l'opération pour la validation
                    const operationName = node.name?.value;

                    // Exemption des requêtes d'introspection en développement
                    if (config.ENVIRONMENT !== 'production' && operationName === 'IntrospectionQuery') {
                        return;
                    }

                    // Autorisation de toutes les opérations par défaut
                    return true;
                }
            })
        ],
        // Plugins du cycle de vie des requêtes
        plugins: [requestLifecyclePlugin]
    });

    // Démarrage du serveur Apollo
    await server.start();

    // Application du middleware Apollo via Express
    app.use(
        '/graphql',
        expressMiddleware(server, {
            context: async ({ req, res }: { req: Request; res: Response }): Promise<ServerContext> => {
                // Extraction de l'identifiant de base de données depuis les en-têtes
                const headerDatabase = req.headers['x-database-id'] as string | undefined;

                // Validation du routage vers la base de données spécifiée
                let validatedDatabase: string | null = null;
                if (headerDatabase) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                        validatedDatabase = databaseManager.validateDatabaseRouting(null, headerDatabase) as string | null;
                    } catch (error) {
                        logger.warn('Invalid database specified in header', {
                            requestedDatabase: headerDatabase,
                            error: (error as Error).message
                        });
                        // Poursuite avec la base de données par défaut plutôt qu'un échec
                    }
                }

                return {
                    requestId: uuidv4(),
                    loaders: createLoaders(validatedDatabase),
                    databaseManager,
                    requestDatabase: validatedDatabase,
                    getLoadersForDatabase: (databaseId: string | null): LoadersCollection | null => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                        const targetDb = databaseManager.validateDatabaseRouting(databaseId, validatedDatabase) as string | null;
                        return targetDb === validatedDatabase ? null : createLoaders(targetDb);
                    },
                    req,
                    res
                };
            }
        })
    );

    // Middleware de gestion des erreurs Express non capturées
    app.use((err: ExpressError, req: Request, res: Response, _next: NextFunction): void => {
        // Génération d'un identifiant unique associé à l'erreur
        const errorId = uuidv4();
        logger.error('Unexpected error:', {
            error: err,
            errorId,
            requestId: (req as Request & { requestId?: string }).requestId
        });
        // Distinction du message d'erreur selon l'environnement
        const isProduction = config.ENVIRONMENT === 'production';
        res.status(err.status ?? 500).json({
            error: isProduction ? 'Internal server error' : err.message,
            errorId,
            requestId: (req as Request & { requestId?: string }).requestId
        });
    });

    // Gestionnaire de fermeture gracieuse du serveur
    const gracefulShutdown = async (signal: string): Promise<void> => {
        logger.info(`Received ${signal} signal. Starting graceful shutdown...`);
        try {
            await Promise.all([
                // Fermeture du client Redis
                redis.quit(),
                // Fermeture de l'ensemble des connexions DuckDB
                closeAllConnections(),
                // Nettoyage des ressources du gestionnaire de sécurité
                securityManager.cleanup(),
                // Arrêt du serveur Apollo
                server.stop()
            ]);
            logger.info('Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            logger.error('Error during graceful shutdown:', error);
            process.exit(1);
        }
    };

    // Abonnement aux signaux de fermeture du processus
    process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
    // Abonnement au signal d'interruption (Ctrl+C en développement)
    process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

    // Initialisation du port d'écoute
    const port = process.env['PORT'] ?? 4000;
    app.listen(port, () => {
        logger.info(`Server ready at http://localhost:${port}/graphql`);
        logger.info(`Environment: ${config.ENVIRONMENT}`);
        logger.info(`GraphQL Playground: ${config.API.GRAPHQL.PLAYGROUND ? 'enabled' : 'disabled'}`);
    });
}

export { startServer };
export type { ServerContext, ServerMetrics };
