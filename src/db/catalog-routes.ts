// Routes d'administration du catalogue DuckLake (rechargement après mise à jour externe)
import type { Request, Response, Express } from 'express';
import { databaseManager } from './index.js';
import { catalogFreshnessMonitor } from './catalog-freshness.js';
import { requireAdminKey } from '../security/admin-auth.js';
import { createContextLogger } from '../utils/logger.js';

// Logger spécifique au module de rechargement du catalogue
const catalogLogger = createContextLogger({
  component: 'database',
  module: 'catalog-routes',
});

/**
 * Registers catalog administration routes on an Express application.
 *
 * Protected by the same `requireAdminKey` middleware as the cache routes
 * (`x-admin-key` header, 503 fail-safe when ADMIN_API_KEY is unset).
 *
 * Routes registered:
 * - `POST /api/catalog/reload` — immediate freshness probe with a forced
 *   rebuild of the shared DuckDB instance on the pod that receives it. Every
 *   pod already detects updates on its own (`catalog-freshness.ts`), so an
 *   updater may simply wait for the probe interval; this route only speeds one
 *   pod up. Resolves once the new catalog serves and its data versions (hence
 *   the cache namespaces) are switched: no cache invalidation is needed.
 * - `POST /api/catalog/reload/:catalog` — reattach a single catalog (scoped
 *   DETACH + ATTACH on the live instance) so one catalog can be refreshed
 *   without rebuilding the whole instance.
 *
 * @param app - Express application instance to register routes on.
 */
const createCatalogRoutes = (app: Express): void => {
  // POST /api/catalog/reload — sonde immédiate avec rechargement forcé
  // (compatibilité : l'updater peut aussi se contenter d'attendre l'intervalle)
  app.post('/api/catalog/reload', requireAdminKey, async (_req: Request, res: Response) => {
    try {
      const outcome = await catalogFreshnessMonitor.probeNow({ forceReload: true });
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        changed: outcome.changed,
        versions: outcome.versions,
      });
    } catch (error) {
      catalogLogger.error('Catalog reload endpoint error', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // POST /api/catalog/reload/:catalog — ré-attache un seul catalogue
  app.post('/api/catalog/reload/:catalog', requireAdminKey, async (req: Request, res: Response) => {
    // Extraction et normalisation du paramètre de catalogue depuis l'URL
    const catalog = Array.isArray(req.params['catalog'])
      ? req.params['catalog'][0]
      : req.params['catalog'];

    // Rejet précoce si le catalogue est inconnu (404 plutôt que 500)
    if (!catalog || !databaseManager.isValidCatalog(catalog)) {
      res.status(404).json({
        error: `Catalog '${catalog ?? ''}' is not available.`,
        availableCatalogs: databaseManager.getAvailableCatalogs(),
      });
      return;
    }

    try {
      await databaseManager.reloadCatalog(catalog);
      res.json({ success: true, catalog, timestamp: new Date().toISOString() });
    } catch (error) {
      catalogLogger.error('Single catalog reload endpoint error', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });
};

export { createCatalogRoutes };
