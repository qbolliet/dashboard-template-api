// Middleware d'authentification pour les endpoints d'administration (cache, catalogue)
import type { Request, Response, NextFunction } from 'express';

/**
 * Express middleware that enforces API key authentication for admin endpoints.
 *
 * The caller must provide a valid `x-admin-key` header matching the
 * ADMIN_API_KEY environment variable. Access is denied by default when the
 * variable is not set (fail-safe behaviour).
 *
 * @param req - Incoming HTTP request.
 * @param res - HTTP response object.
 * @param next - Next middleware function in the chain.
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

export { requireAdminKey };
