// Utilitaires d'invalidation de cache pour les mises à jour de base de données
import { redis } from './index.js';
import { createContextLogger } from '../utils/logger.js';
import { config } from '../utils/config-loader.js';

// Initialisation du logger spécifique au module d'invalidation de cache
const cacheLogger = createContextLogger({
    component: 'cache',
    module: 'invalidation'
});

/**
 * Cache invalidation manager for handling database updates
 */
class CacheInvalidationManager {
    // SCAN itératif non-bloquant
    async scanKeys(pattern) {
        const keys = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            keys.push(...batch);
            cursor = nextCursor;
        } while (cursor !== '0');
        return keys;
    }

    constructor() {
        // Définition des motifs de clés pour chaque type de cache
        // Permet de cibler précisément les caches à invalider par base de données
        this.keyPatterns = {
            // Motifs spécifiques aux bases de données - chaque type de données a son propre espace de noms
            metadata: (dbId) => `metadata:${dbId || 'default'}:*`,
            dimension: (dbId) => `dimension:${dbId || 'default'}:*`,
            dimensionValue: (dbId) => `dimension-value:${dbId || 'default'}:*`,
            facts: (dbId) => `facts:${dbId || 'default'}:*`,
            aggregatedFacts: (dbId) => `aggregated-facts:${dbId || 'default'}:*`,
            selectOptions: (dbId) => `select-options:${dbId || 'default'}:*`,
            // Motif global pour invalider tous les caches d'une base de données
            allDatabase: (dbId) => `*:${dbId || 'default'}:*`,
        };
    }

    /**
     * Invalidate all cache entries for a specific database
     * @param {string} databaseId - Database identifier
     */
    async invalidateDatabase(databaseId = null) {
        // Utilisation de 'default' comme base de données par défaut si aucune n'est spécifiée
        const dbId = databaseId || 'default';
        cacheLogger.info(`Starting cache invalidation for database: ${dbId}`);

        try {
            // Construction du motif pour trouver toutes les clés liées à cette base de données
            const pattern = this.keyPatterns.allDatabase(dbId);
            
            // Récupération de toutes les clés correspondant au motif
            const keys = await this.scanKeys(pattern);
            
            // Suppression des clés trouvées si elles existent
            if (keys.length > 0) {
                // Suppression en lot pour optimiser les performances
                await redis.del(keys);
                cacheLogger.info(`Invalidated ${keys.length} cache entries for database: ${dbId}`, {
                    databaseId: dbId,
                    keysCount: keys.length
                });
            } else {
                // Aucune clé trouvée - peut-être normal si le cache était vide
                cacheLogger.info(`No cache entries found for database: ${dbId}`, {
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
     * Invalidate specific cache type for a database
     * @param {string} cacheType - Type of cache (metadata, dimension, facts, etc.)
     * @param {string} databaseId - Database identifier
     */
    async invalidateCacheType(cacheType, databaseId = null) {
        const dbId = databaseId || 'default';
        
        // Vérification que le type de cache existe dans nos motifs définis
        if (!this.keyPatterns[cacheType]) {
            throw new Error(`Unknown cache type: ${cacheType}`);
        }

        try {
            // Construction du motif spécifique au type de cache demandé
            const pattern = this.keyPatterns[cacheType](dbId);
            
            // Recherche des clés correspondant à ce type de cache
            const keys = await this.scanKeys(pattern);
            
            // Suppression sélective des clés trouvées
            if (keys.length > 0) {
                await redis.del(keys);
                cacheLogger.info(`Invalidated ${cacheType} cache for database: ${dbId}`, {
                    cacheType,
                    databaseId: dbId,
                    keysCount: keys.length
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
     * Invalidate all caches across all databases
     */
    async invalidateAllDatabases() {
        cacheLogger.info('Starting global cache invalidation');

        try {
            // Récupération de la liste de toutes les bases de données configurées
            const databases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
            
            // Création des promesses d'invalidation pour chaque base de données
            // Utilisation de catch pour éviter qu'une base de données échoue et arrête tout le processus
            const invalidationPromises = databases.map(dbId => 
                this.invalidateDatabase(dbId).catch(error => {
                    // Log de l'erreur mais continuation du processus pour les autres bases
                    cacheLogger.error(`Failed to invalidate database ${dbId}`, error);
                    return { database: dbId, error: error.message };
                })
            );

            // Exécution de toutes les invalidations en parallèle
            const results = await Promise.allSettled(invalidationPromises);
            
            // Analyse des résultats pour identifier les échecs
            const failures = results.filter(r => r.status === 'rejected' || r.value?.error);
            
            // Rapport final avec statistiques de succès/échec
            if (failures.length > 0) {
                cacheLogger.warn(`Some cache invalidations failed`, {
                    failures: failures.length,
                    total: databases.length
                });
            } else {
                cacheLogger.info('Global cache invalidation completed successfully');
            }
        } catch (error) {
            // Erreur globale - généralement un problème de configuration
            cacheLogger.error('Failed to perform global cache invalidation', error);
            throw error;
        }
    }

    /**
     * Get cache statistics for monitoring
     */
    async getCacheStats() {
        try {
            // Récupération de toutes les bases de données configurées
            const databases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
            const stats = {};

            // Parcours de chaque base de données pour collecter les statistiques
            for (const dbId of databases) {
                const dbStats = {};
                
                // Parcours de chaque type de cache pour compter les clés
                for (const [type, patternFn] of Object.entries(this.keyPatterns)) {
                    // Exclusion du motif global qui compte tout
                    if (type === 'allDatabase') continue;
                    
                    // Construction du motif et comptage des clés correspondantes
                    const pattern = patternFn(dbId);
                    const keys = await this.scanKeys(pattern);
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

/**
 * Middleware de vérification de la clé API admin
 * La clé doit être fournie dans le header x-admin-key
 */
const requireAdminKey = (req, res, next) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
        // Si aucune clé n'est configurée, refuser l'accès par défaut (fail-safe)
        return res.status(503).json({ error: 'Admin endpoint not configured (ADMIN_API_KEY missing)' });
    }
    const provided = req.headers['x-admin-key'];
    if (!provided || provided !== adminKey) {
        return res.status(401).json({ error: 'Unauthorized: valid x-admin-key header required' });
    }
    next();
};

/**
 * Express middleware for cache invalidation endpoints
 */
const createCacheInvalidationRoutes = (app) => {
    // Route pour invalider le cache d'une base de données spécifique
    // POST /api/cache/invalidate/:database
    app.post('/api/cache/invalidate/:database', requireAdminKey, async (req, res) => {
        try {
            // Extraction du paramètre de base de données depuis l'URL
            const { database } = req.params;
            
            // Exécution de l'invalidation du cache pour la base spécifiée
            await cacheInvalidationManager.invalidateDatabase(database);
            
            // Réponse de succès avec horodatage
            res.json({ success: true, database, timestamp: new Date().toISOString() });
        } catch (error) {
            // Gestion des erreurs avec logging et réponse d'erreur appropriée
            cacheLogger.error('Cache invalidation endpoint error', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Route pour invalider tous les caches de toutes les bases de données
    // POST /api/cache/invalidate-all
    app.post('/api/cache/invalidate-all', requireAdminKey, async (req, res) => {
        try {
            // Invalidation globale de tous les caches
            await cacheInvalidationManager.invalidateAllDatabases();
            
            // Confirmation de succès avec horodatage
            res.json({ success: true, timestamp: new Date().toISOString() });
        } catch (error) {
            // Gestion des erreurs d'invalidation globale
            cacheLogger.error('Global cache invalidation endpoint error', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Route pour obtenir les statistiques de cache
    // GET /api/cache/stats
    app.get('/api/cache/stats', requireAdminKey, async (req, res) => {
        try {
            // Collecte des statistiques de cache pour toutes les bases
            const stats = await cacheInvalidationManager.getCacheStats();
            
            // Retour des statistiques avec horodatage
            res.json({ stats, timestamp: new Date().toISOString() });
        } catch (error) {
            // Gestion des erreurs de collecte de statistiques
            cacheLogger.error('Cache stats endpoint error', error);
            res.status(500).json({ error: error.message });
        }
    });
};

export { 
    cacheInvalidationManager, 
    CacheInvalidationManager,
    createCacheInvalidationRoutes 
};