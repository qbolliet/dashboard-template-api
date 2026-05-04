// Utilitaires d'invalidation de cache pour les mises à jour de base de données
import type { Request, Response, NextFunction, Express } from 'express';
import { redis } from './index.js';
import { createContextLogger } from '../utils/logger.js';
import { config } from '../utils/config-loader.js';

// Initialisation du logger spécifique au module d'invalidation de cache
const cacheLogger = createContextLogger({
    component: 'cache',
    module:    'invalidation'
});

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Function that generates a Redis key pattern for a given database identifier.
 *
 * Args:
 *     dbId: Database identifier, or null/undefined to use 'default'.
 *
 * Returns:
 *     Redis glob pattern string.
 */
type KeyPatternFn = (dbId?: string | null) => string;

/** Dictionnaire des générateurs de motifs de clés Redis par type de cache. */
interface KeyPatterns {
    metadata:        KeyPatternFn;
    dimension:       KeyPatternFn;
    dimensionValue:  KeyPatternFn;
    facts:           KeyPatternFn;
    aggregatedFacts: KeyPatternFn;
    selectOptions:   KeyPatternFn;
    /** Motif global — correspond à toutes les clés d'une base de données. */
    allDatabase:     KeyPatternFn;
}

/** Résultat d'une tentative d'invalidation pour une base de données. */
interface InvalidationResult {
    database: string;
    error?:   string;
}

/** Comptage des clés Redis par type de cache pour une base de données. */
type DatabaseStats = Record<string, number>;

/** Statistiques globales de cache indexées par identifiant de base de données. */
type CacheStats = Record<string, DatabaseStats>;

// ─── Gestionnaire d'invalidation de cache ────────────────────────────────────

/**
 * Cache invalidation manager for handling database updates.
 *
 * Provides methods to invalidate Redis cache entries by database, cache type,
 * or globally across all configured databases. Uses non-blocking SCAN to avoid
 * locking Redis during key discovery.
 */
class CacheInvalidationManager {
    // Dictionnaire des générateurs de motifs de clés par type de cache
    readonly keyPatterns: KeyPatterns;

    constructor() {
        // Définition des motifs de clés pour chaque type de cache
        // Permet de cibler précisément les caches à invalider par base de données
        this.keyPatterns = {
            // Motifs spécifiques aux bases de données — chaque type a son propre espace de noms
            metadata:        (dbId) => `metadata:${dbId || 'default'}:*`,
            dimension:       (dbId) => `dimension:${dbId || 'default'}:*`,
            dimensionValue:  (dbId) => `dimension-value:${dbId || 'default'}:*`,
            facts:           (dbId) => `facts:${dbId || 'default'}:*`,
            aggregatedFacts: (dbId) => `aggregated-facts:${dbId || 'default'}:*`,
            selectOptions:   (dbId) => `select-options:${dbId || 'default'}:*`,
            // Motif global pour invalider tous les caches d'une base de données
            allDatabase:     (dbId) => `*:${dbId || 'default'}:*`,
        };
    }

    /**
     * Iterates through all Redis keys matching a pattern using non-blocking SCAN.
     *
     * Avoids the blocking KEYS command by iterating with cursor-based SCAN,
     * collecting results in batches of 100.
     *
     * Args:
     *     pattern: Redis glob pattern to match (e.g. "metadata:db1:*").
     *
     * Returns:
     *     Array of all matching Redis key strings.
     *
     * Raises:
     *     Error: When the Redis SCAN command fails.
     */
    // SCAN itératif non-bloquant — évite le blocage de Redis sur de grands ensembles de clés
    async scanKeys(pattern: string): Promise<string[]> {
        const keys: string[] = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            keys.push(...batch);
            cursor = nextCursor;
        } while (cursor !== '0');
        return keys;
    }

    /**
     * Invalidate all cache entries for a specific database.
     *
     * Uses the 'allDatabase' key pattern to find and delete every cache entry
     * associated with the given database identifier.
     *
     * Args:
     *     databaseId: Database identifier. Defaults to 'default' when null.
     *
     * Raises:
     *     Error: When the Redis DEL operation fails.
     */
    async invalidateDatabase(databaseId: string | null = null): Promise<void> {
        // Utilisation de 'default' comme base de données par défaut si aucune n'est spécifiée
        const dbId = databaseId ?? 'default';
        cacheLogger.cache(`Starting cache invalidation for database: ${dbId}`);

        try {
            // Construction du motif pour trouver toutes les clés liées à cette base de données
            const pattern = this.keyPatterns.allDatabase(dbId);

            // Récupération de toutes les clés correspondant au motif
            const keys = await this.scanKeys(pattern);

            // Suppression des clés trouvées si elles existent
            if (keys.length > 0) {
                // Suppression en lot pour optimiser les performances
                await redis.del(...keys);
                cacheLogger.cache(`Invalidated ${keys.length} cache entries for database: ${dbId}`, {
                    databaseId: dbId,
                    keysCount:  keys.length
                });
            } else {
                // Aucune clé trouvée — le cache était déjà vide ou inexistant
                cacheLogger.cache(`No cache entries found for database: ${dbId}`, {
                    databaseId: dbId
                });
            }
        } catch (error) {
            // Gestion des erreurs avec logging détaillé
            cacheLogger.error(`Failed to invalidate cache for database: ${dbId}`, error, {
                databaseId: dbId
            });
            throw error;
        }
    }

    /**
     * Invalidate a specific cache type for a given database.
     *
     * Args:
     *     cacheType: Cache type key (metadata, dimension, facts, etc.).
     *     databaseId: Database identifier. Defaults to 'default' when null.
     *
     * Raises:
     *     Error: When the cache type is unknown or the Redis operation fails.
     */
    async invalidateCacheType(cacheType: string, databaseId: string | null = null): Promise<void> {
        const dbId = databaseId ?? 'default';

        // Vérification que le type de cache existe dans nos motifs définis
        if (!(cacheType in this.keyPatterns)) {
            throw new Error(`Unknown cache type: ${cacheType}`);
        }

        try {
            // Construction du motif spécifique au type de cache demandé
            const pattern = this.keyPatterns[cacheType as keyof KeyPatterns](dbId);

            // Recherche des clés correspondant à ce type de cache
            const keys = await this.scanKeys(pattern);

            // Suppression sélective des clés trouvées
            if (keys.length > 0) {
                await redis.del(...keys);
                cacheLogger.cache(`Invalidated ${cacheType} cache for database: ${dbId}`, {
                    cacheType,
                    databaseId: dbId,
                    keysCount:  keys.length
                });
            }
        } catch (error) {
            // Gestion d'erreur avec contexte spécifique au type de cache
            cacheLogger.error(`Failed to invalidate ${cacheType} cache for database: ${dbId}`, error, {
                cacheType,
                databaseId: dbId
            });
            throw error;
        }
    }

    /**
     * Invalidate all caches across all configured databases in parallel.
     *
     * Individual database failures are logged and captured but do not abort
     * the remaining invalidations.
     *
     * Raises:
     *     Error: When the database list cannot be retrieved from config.
     */
    async invalidateAllDatabases(): Promise<void> {
        cacheLogger.cache('Starting global cache invalidation');

        try {
            // Récupération de la liste de toutes les bases de données configurées
            const rawDatabases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
            const databases: string[] = Array.isArray(rawDatabases)
                ? rawDatabases
                : (JSON.parse(rawDatabases) as string[]);

            // Création des promesses d'invalidation pour chaque base de données
            // Capture des erreurs individuelles pour ne pas bloquer le reste du processus
            const invalidationPromises = databases.map((dbId) =>
                this.invalidateDatabase(dbId).catch((error: Error): InvalidationResult => {
                    // Journalisation de l'erreur mais continuation pour les autres bases
                    cacheLogger.error(`Failed to invalidate database ${dbId}`, error);
                    return { database: dbId, error: error.message };
                })
            );

            // Exécution de toutes les invalidations en parallèle
            const results = await Promise.allSettled(invalidationPromises);

            // Analyse des résultats pour identifier les échecs
            const failures = results.filter(
                (r): boolean =>
                    r.status === 'rejected' ||
                    (r.status === 'fulfilled' && Boolean((r.value as InvalidationResult)?.error))
            );

            // Rapport final avec statistiques de succès/échec
            if (failures.length > 0) {
                cacheLogger.warn('Some cache invalidations failed', {
                    failures: failures.length,
                    total:    databases.length
                });
            } else {
                cacheLogger.cache('Global cache invalidation completed successfully');
            }
        } catch (error) {
            // Erreur globale — généralement un problème de configuration
            cacheLogger.error('Failed to perform global cache invalidation', error);
            throw error;
        }
    }

    /**
     * Collect Redis key counts per cache type for all configured databases.
     *
     * Returns:
     *     Nested record mapping each database ID to a per-type key count map.
     *
     * Raises:
     *     Error: When the Redis SCAN operation fails.
     */
    async getCacheStats(): Promise<CacheStats> {
        try {
            // Récupération de toutes les bases de données configurées
            const rawDatabases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
            const databases: string[] = Array.isArray(rawDatabases)
                ? rawDatabases
                : (JSON.parse(rawDatabases) as string[]);
            const stats: CacheStats = {};

            // Parcours de chaque base de données pour collecter les statistiques
            for (const dbId of databases) {
                const dbStats: DatabaseStats = {};

                // Parcours de chaque type de cache pour compter les clés correspondantes
                for (const [type, patternFn] of Object.entries(this.keyPatterns) as [keyof KeyPatterns, KeyPatternFn][]) {
                    // Exclusion du motif global — il chevauche tous les autres types
                    if (type === 'allDatabase') continue;

                    // Construction du motif et comptage des clés correspondantes
                    const pattern = patternFn(dbId);
                    const keys    = await this.scanKeys(pattern);
                    dbStats[type] = keys.length;
                }

                // Stockage des statistiques pour cette base de données
                stats[dbId] = dbStats;
            }

            return stats;
        } catch (error) {
            // Gestion des erreurs lors de la collecte des statistiques
            cacheLogger.error('Failed to get cache statistics', error);
            throw error;
        }
    }
}

// Création de l'instance singleton du gestionnaire d'invalidation de cache
const cacheInvalidationManager = new CacheInvalidationManager();

// ─── Middleware d'authentification admin ──────────────────────────────────────

/**
 * Express middleware that enforces API key authentication for admin endpoints.
 *
 * The caller must provide a valid `x-admin-key` header matching the
 * ADMIN_API_KEY environment variable. Access is denied by default when the
 * variable is not set (fail-safe behaviour).
 *
 * Args:
 *     req: Incoming HTTP request.
 *     res: HTTP response object.
 *     next: Next middleware function in the chain.
 */
// Vérification de la clé API admin — refus systématique si non configurée (fail-safe)
const requireAdminKey = (req: Request, res: Response, next: NextFunction): void => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
        // Aucune clé configurée — refus par défaut pour sécuriser l'endpoint
        res.status(503).json({ error: 'Admin endpoint not configured (ADMIN_API_KEY missing)' });
        return;
    }
    const provided = req.headers['x-admin-key'];
    if (!provided || provided !== adminKey) {
        res.status(401).json({ error: 'Unauthorized: valid x-admin-key header required' });
        return;
    }
    next();
};

// ─── Routes d'administration du cache ────────────────────────────────────────

/**
 * Registers cache administration routes on an Express application.
 *
 * All routes are protected by the requireAdminKey middleware.
 *
 * Routes:
 *     POST /api/cache/invalidate/:database — invalidate a single database cache.
 *     POST /api/cache/invalidate-all       — invalidate all database caches.
 *     GET  /api/cache/stats                — retrieve per-type key counts.
 *
 * Args:
 *     app: Express application instance to register routes on.
 */
const createCacheInvalidationRoutes = (app: Express): void => {
    // Route pour invalider le cache d'une base de données spécifique
    // POST /api/cache/invalidate/:database
    app.post('/api/cache/invalidate/:database', requireAdminKey, async (req: Request, res: Response) => {
        try {
            // Extraction et normalisation du paramètre de base de données depuis l'URL
            const database = Array.isArray(req.params['database'])
                ? req.params['database'][0]
                : req.params['database'];

            // Exécution de l'invalidation du cache pour la base spécifiée
            await cacheInvalidationManager.invalidateDatabase(database);

            // Réponse de succès avec horodatage
            res.json({ success: true, database, timestamp: new Date().toISOString() });
        } catch (error) {
            // Gestion des erreurs avec logging et réponse d'erreur appropriée
            cacheLogger.error('Cache invalidation endpoint error', error);
            res.status(500).json({ error: (error as Error).message });
        }
    });

    // Route pour invalider tous les caches de toutes les bases de données
    // POST /api/cache/invalidate-all
    app.post('/api/cache/invalidate-all', requireAdminKey, async (_req: Request, res: Response) => {
        try {
            // Invalidation globale de tous les caches
            await cacheInvalidationManager.invalidateAllDatabases();

            // Confirmation de succès avec horodatage
            res.json({ success: true, timestamp: new Date().toISOString() });
        } catch (error) {
            // Gestion des erreurs d'invalidation globale
            cacheLogger.error('Global cache invalidation endpoint error', error);
            res.status(500).json({ error: (error as Error).message });
        }
    });

    // Route pour obtenir les statistiques de cache
    // GET /api/cache/stats
    app.get('/api/cache/stats', requireAdminKey, async (_req: Request, res: Response) => {
        try {
            // Collecte des statistiques de cache pour toutes les bases
            const stats = await cacheInvalidationManager.getCacheStats();

            // Retour des statistiques avec horodatage
            res.json({ stats, timestamp: new Date().toISOString() });
        } catch (error) {
            // Gestion des erreurs de collecte de statistiques
            cacheLogger.error('Cache stats endpoint error', error);
            res.status(500).json({ error: (error as Error).message });
        }
    });
};

export { cacheInvalidationManager, CacheInvalidationManager, createCacheInvalidationRoutes };
export type { KeyPatterns, KeyPatternFn, InvalidationResult, DatabaseStats, CacheStats };
