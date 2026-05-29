// Utilitaires d'invalidation de cache pour les mises à jour de base de données
import type { Request, Response, Express } from 'express';
import { redis } from './index.js';
import { createContextLogger } from '../utils/logger.js';
import { databaseManager } from '../db/index.js';
import { requireAdminKey } from '../security/admin-auth.js';

// Initialisation du logger spécifique au module d'invalidation de cache
const cacheLogger = createContextLogger({
  component: 'cache',
  module: 'invalidation',
});

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Generates a Redis key glob pattern for a (catalog, schema?) pair.
 *
 * When `schema` is null/undefined, the resulting pattern matches **every**
 * schema of the catalog (the schema segment becomes a `*`). When both
 * arguments are null, the pattern matches the legacy 'default' catalog.
 *
 * @param catalog - Catalog identifier, or null/undefined to use 'default'.
 * @param schema - Schema name, or null/undefined to match all schemas.
 * @returns Redis glob pattern string.
 */
type KeyPatternFn = (catalog?: string | null, schema?: string | null) => string;

/** Dictionary of Redis key-pattern generators indexed by cache type. */
interface KeyPatterns {
  metadata: KeyPatternFn;
  dimension: KeyPatternFn;
  dimensionValue: KeyPatternFn;
  facts: KeyPatternFn;
  aggregatedFacts: KeyPatternFn;
  selectOptions: KeyPatternFn;
  /** Global pattern — matches every cache type for the given (catalog, schema?). */
  allCatalog: KeyPatternFn;
}

/** Result of a single cache invalidation attempt for a catalog. */
interface InvalidationResult {
  catalog: string;
  error?: string;
}

/** Redis key count per cache type within a single schema. */
type SchemaStats = Record<string, number>;

/** Per-schema stats inside a catalog (schema → type → count). */
type CatalogStats = Record<string, SchemaStats>;

/** Global cache statistics (catalog → schema → type → count). */
type CacheStats = Record<string, CatalogStats>;

// ─── Gestionnaire d'invalidation de cache ────────────────────────────────────

/**
 * Cache invalidation manager for handling database updates.
 *
 * Provides three granularities of invalidation, all backed by non-blocking
 * Redis SCAN:
 *  - **schema**: a single (catalog, schema) pair
 *  - **catalog**: every schema of a given catalog (schema wildcard)
 *  - **all**: every configured catalog in turn
 *
 * Cache keys are written by loaders in the form
 * `<type>:<catalog>:<schema>:<queryKey>` (see `BaseQueryLoader.loadWithCache`),
 * so the patterns here align with that layout.
 */
class CacheInvalidationManager {
  // Dictionnaire des générateurs de motifs de clés par type de cache
  readonly keyPatterns: KeyPatterns;

  constructor() {
    // Motifs de clés : segment catalog obligatoire, segment schema soit explicite
    // soit wildcard (=> tous les schémas du catalogue).
    // Note : || (et non ??) — une chaîne vide doit également retomber sur le défaut.
    this.keyPatterns = {
      metadata: (catalog, schema) => `metadata:${catalog || 'default'}:${schema || '*'}:*`,
      dimension: (catalog, schema) => `dimension:${catalog || 'default'}:${schema || '*'}:*`,
      dimensionValue: (catalog, schema) =>
        `dimension-value:${catalog || 'default'}:${schema || '*'}:*`,
      facts: (catalog, schema) => `facts:${catalog || 'default'}:${schema || '*'}:*`,
      aggregatedFacts: (catalog, schema) =>
        `aggregated-facts:${catalog || 'default'}:${schema || '*'}:*`,
      selectOptions: (catalog, schema) =>
        `select-options:${catalog || 'default'}:${schema || '*'}:*`,
      // Tous les types pour un (catalog, schema?) donné
      allCatalog: (catalog, schema) => `*:${catalog || 'default'}:${schema || '*'}:*`,
    };
  }

  /**
   * Iterates through all Redis keys matching a pattern using non-blocking SCAN.
   *
   * Avoids the blocking KEYS command by iterating with cursor-based SCAN,
   * collecting results in batches of 100.
   *
   * @param pattern - Redis glob pattern to match (e.g. "metadata:db1:main:*").
   * @returns Array of all matching Redis key strings.
   * @throws {Error} When the Redis SCAN command fails.
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
   * Invalidate cache entries for a catalog — optionally narrowed to one schema.
   *
   * Without `schema`, every schema of the catalog is invalidated (the schema
   * segment is matched with `*`). With `schema`, only that (catalog, schema)
   * namespace is touched, leaving the rest of the catalog intact.
   *
   * @param catalog - Catalog identifier. Defaults to 'default' when null.
   * @param schema - Optional schema name; null/omitted means "all schemas".
   * @throws {Error} When the Redis DEL operation fails.
   */
  async invalidateCatalog(
    catalog: string | null = null,
    schema: string | null = null,
  ): Promise<void> {
    // Utilisation de 'default' comme catalogue par défaut si aucun n'est spécifié
    const catalogId = catalog ?? 'default';
    const scope = schema ? `${catalogId}/${schema}` : catalogId;
    cacheLogger.cache(`Starting cache invalidation for: ${scope}`);

    try {
      // Construction du motif englobant tous les types pour ce (catalog, schema?)
      const pattern = this.keyPatterns.allCatalog(catalogId, schema);

      // Récupération de toutes les clés correspondant au motif
      const keys = await this.scanKeys(pattern);

      // Suppression des clés trouvées si elles existent
      if (keys.length > 0) {
        // Suppression en lot pour optimiser les performances
        await redis.del(...keys);
        cacheLogger.cache(`Invalidated ${keys.length} cache entries for: ${scope}`, {
          catalogId,
          schema: schema ?? null,
          keysCount: keys.length,
        });
      } else {
        // Aucune clé trouvée — le cache était déjà vide ou inexistant
        cacheLogger.cache(`No cache entries found for: ${scope}`, {
          catalogId,
          schema: schema ?? null,
        });
      }
    } catch (error) {
      // Gestion des erreurs avec logging détaillé
      cacheLogger.error(`Failed to invalidate cache for: ${scope}`, error, {
        catalogId,
        schema: schema ?? null,
      });
      throw error;
    }
  }

  /**
   * Invalidate a specific cache type for a given catalog (and optional schema).
   *
   * @param cacheType - Cache type key (metadata, dimension, facts, etc.).
   * @param catalog - Catalog identifier. Defaults to 'default' when null.
   * @param schema - Optional schema name; null/omitted means "all schemas".
   * @throws {Error} When the cache type is unknown or the Redis operation fails.
   */
  async invalidateCacheType(
    cacheType: string,
    catalog: string | null = null,
    schema: string | null = null,
  ): Promise<void> {
    const catalogId = catalog ?? 'default';
    const scope = schema ? `${catalogId}/${schema}` : catalogId;

    // Vérification que le type de cache existe dans nos motifs définis
    if (!(cacheType in this.keyPatterns)) {
      throw new Error(`Unknown cache type: ${cacheType}`);
    }

    try {
      // Construction du motif spécifique au type de cache demandé
      const pattern = this.keyPatterns[cacheType as keyof KeyPatterns](catalogId, schema);

      // Recherche des clés correspondant à ce type de cache
      const keys = await this.scanKeys(pattern);

      // Suppression sélective des clés trouvées
      if (keys.length > 0) {
        await redis.del(...keys);
        cacheLogger.cache(`Invalidated ${cacheType} cache for: ${scope}`, {
          cacheType,
          catalogId,
          schema: schema ?? null,
          keysCount: keys.length,
        });
      }
    } catch (error) {
      // Gestion d'erreur avec contexte spécifique au type de cache
      cacheLogger.error(`Failed to invalidate ${cacheType} cache for: ${scope}`, error, {
        cacheType,
        catalogId,
        schema: schema ?? null,
      });
      throw error;
    }
  }

  /**
   * Invalidate all caches across all configured catalogs in parallel.
   *
   * Each catalog invalidation covers every schema of that catalog. Individual
   * catalog failures are logged and captured but do not abort the remaining
   * invalidations.
   *
   * @throws {Error} When the catalog list cannot be retrieved.
   */
  async invalidateAllCatalogs(): Promise<void> {
    cacheLogger.cache('Starting global cache invalidation');

    try {
      // Liste de tous les catalogues configurés (source de vérité = databaseManager)
      const catalogs = databaseManager.getAvailableCatalogs();

      // Création des promesses d'invalidation pour chaque catalogue
      // Capture des erreurs individuelles pour ne pas bloquer le reste du processus
      const invalidationPromises = catalogs.map((catalogId) =>
        this.invalidateCatalog(catalogId).catch((error: Error): InvalidationResult => {
          // Journalisation de l'erreur mais continuation pour les autres catalogues
          cacheLogger.error(`Failed to invalidate catalog ${catalogId}`, error);
          return { catalog: catalogId, error: error.message };
        }),
      );

      // Exécution de toutes les invalidations en parallèle
      const results = await Promise.allSettled(invalidationPromises);

      // Analyse des résultats pour identifier les échecs
      const failures = results.filter(
        (r): boolean =>
          r.status === 'rejected' ||
          (r.status === 'fulfilled' && Boolean((r.value as InvalidationResult)?.error)),
      );

      // Rapport final avec statistiques de succès/échec
      if (failures.length > 0) {
        cacheLogger.warn('Some cache invalidations failed', {
          failures: failures.length,
          total: catalogs.length,
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
   * Collect Redis key counts per cache type, broken down by catalog and schema.
   *
   * For each configured catalog the manager iterates its declared schemas
   * (via {@link databaseManager.getSchemas}) and counts keys per type.
   *
   * @returns Nested record `catalog → schema → type → count`.
   * @throws {Error} When the Redis SCAN operation fails.
   */
  async getCacheStats(): Promise<CacheStats> {
    try {
      // Liste de tous les catalogues configurés
      const catalogs = databaseManager.getAvailableCatalogs();
      const stats: CacheStats = {};

      // Parcours de chaque catalogue
      for (const catalogId of catalogs) {
        const schemas = databaseManager.getSchemas(catalogId);
        const catalogStats: CatalogStats = {};

        // Parcours de chaque schéma déclaré pour ce catalogue
        for (const schema of schemas) {
          const schemaStats: SchemaStats = {};

          // Parcours de chaque type de cache pour compter les clés correspondantes
          for (const [type, patternFn] of Object.entries(this.keyPatterns) as [
            keyof KeyPatterns,
            KeyPatternFn,
          ][]) {
            // Exclusion du motif global — il chevauche tous les autres types
            if (type === 'allCatalog') continue;

            // Construction du motif et comptage des clés correspondantes
            const pattern = patternFn(catalogId, schema);
            const keys = await this.scanKeys(pattern);
            schemaStats[type] = keys.length;
          }

          catalogStats[schema] = schemaStats;
        }

        // Stockage des statistiques pour ce catalogue
        stats[catalogId] = catalogStats;
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

// ─── Routes d'administration du cache ────────────────────────────────────────

/**
 * Registers cache administration routes on an Express application.
 *
 * All routes are protected by the `requireAdminKey` middleware.
 *
 * Routes registered:
 * - `POST /api/cache/invalidate/:catalog` — invalidate every schema of a catalog.
 * - `POST /api/cache/invalidate/:catalog/:schema` — invalidate a single schema.
 * - `POST /api/cache/invalidate-all` — invalidate every catalog in turn.
 * - `GET  /api/cache/stats` — retrieve nested catalog → schema → type key counts.
 *
 * @param app - Express application instance to register routes on.
 */
const createCacheInvalidationRoutes = (app: Express): void => {
  // Helper d'extraction du paramètre :catalog ou :schema, robuste à Express qui
  // renvoie parfois un tableau quand la route est dupliquée
  const pickParam = (raw: string | string[] | undefined): string | null => {
    if (Array.isArray(raw)) return raw[0] ?? null;
    return raw ?? null;
  };

  // POST /api/cache/invalidate/:catalog — tous les schémas du catalogue
  app.post(
    '/api/cache/invalidate/:catalog',
    requireAdminKey,
    async (req: Request, res: Response) => {
      try {
        const catalog = pickParam(req.params['catalog']);

        // Validation 404 du catalogue avant toute opération Redis
        if (!catalog || !databaseManager.isValidCatalog(catalog)) {
          res.status(404).json({
            error: `Catalog '${catalog ?? ''}' is not available.`,
            availableCatalogs: databaseManager.getAvailableCatalogs(),
          });
          return;
        }

        // Exécution de l'invalidation pour tous les schémas du catalogue
        await cacheInvalidationManager.invalidateCatalog(catalog);

        // Réponse de succès avec horodatage
        res.json({ success: true, catalog, timestamp: new Date().toISOString() });
      } catch (error) {
        // Gestion des erreurs avec logging et réponse d'erreur appropriée
        cacheLogger.error('Cache invalidation endpoint error', error);
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // POST /api/cache/invalidate/:catalog/:schema — un seul schéma d'un catalogue
  app.post(
    '/api/cache/invalidate/:catalog/:schema',
    requireAdminKey,
    async (req: Request, res: Response) => {
      try {
        const catalog = pickParam(req.params['catalog']);
        const schema = pickParam(req.params['schema']);

        // Validation 404 du catalogue avant validation du schéma
        if (!catalog || !databaseManager.isValidCatalog(catalog)) {
          res.status(404).json({
            error: `Catalog '${catalog ?? ''}' is not available.`,
            availableCatalogs: databaseManager.getAvailableCatalogs(),
          });
          return;
        }

        // Validation 404 du schéma à l'intérieur du catalogue
        if (!schema || !databaseManager.isValidSchema(catalog, schema)) {
          res.status(404).json({
            error: `Schema '${schema ?? ''}' is not configured for catalog '${catalog}'.`,
            availableSchemas: databaseManager.getSchemas(catalog),
          });
          return;
        }

        // Invalidation ciblée sur (catalog, schema)
        await cacheInvalidationManager.invalidateCatalog(catalog, schema);

        res.json({
          success: true,
          catalog,
          schema,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        cacheLogger.error('Per-schema cache invalidation endpoint error', error);
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Route pour invalider tous les caches de tous les catalogues
  // POST /api/cache/invalidate-all
  app.post('/api/cache/invalidate-all', requireAdminKey, async (_req: Request, res: Response) => {
    try {
      // Invalidation globale de tous les caches
      await cacheInvalidationManager.invalidateAllCatalogs();

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
      // Collecte des statistiques de cache pour tous les (catalog, schema)
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
export type {
  KeyPatterns,
  KeyPatternFn,
  InvalidationResult,
  SchemaStats,
  CatalogStats,
  CacheStats,
};
