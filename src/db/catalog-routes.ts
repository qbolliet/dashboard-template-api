// Routes d'administration du catalogue DuckLake (rechargement après mise à jour externe)
import type { Request, Response, Express } from 'express';
import { databaseManager } from './index.js';
import { requireAdminKey } from '../cache/cache-invalidation.js';
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
 * - `POST /api/catalog/reload` — rebuild the shared DuckDB instance so the API
 *   picks up DuckLake catalogs/data refreshed by an external process, without
 *   restarting the pod. Resolves once the new catalog is attached and serving,
 *   so a cache invalidation can safely be sequenced afterwards.
 *
 * @param app - Express application instance to register routes on.
 */
const createCatalogRoutes = (app: Express): void => {
  // POST /api/catalog/reload — ré-attache les catalogues à jour
  app.post('/api/catalog/reload', requireAdminKey, async (_req: Request, res: Response) => {
    try {
      await databaseManager.reloadCatalogs();
      res.json({ success: true, timestamp: new Date().toISOString() });
    } catch (error) {
      catalogLogger.error('Catalog reload endpoint error', error);
      res.status(500).json({ error: (error as Error).message });
    }
  });
};

export { createCatalogRoutes };
