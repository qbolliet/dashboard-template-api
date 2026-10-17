// Middleware d'authentification pour les endpoints d'administration (cache, catalogue)
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Hashes a secret so that two values can be compared in constant time.
 *
 * @param value - Secret to hash.
 * @returns SHA-256 digest (fixed 32-byte length, whatever the input length).
 */
// Condensé de longueur fixe : timingSafeEqual exige deux tampons de même taille
const digest = (value: string): Buffer => crypto.createHash('sha256').update(value).digest();

/**
 * Express middleware that enforces API key authentication for admin endpoints.
 *
 * The caller must provide a valid `x-admin-key` header matching the
 * ADMIN_API_KEY environment variable. The comparison runs in constant time on
 * SHA-256 digests, so neither the content nor the length of the key leaks
 * through response timing. Access is denied by default when the variable is
 * not set (fail-safe behaviour). Brute force is bounded by the dedicated admin
 * rate limiter mounted in front of these routes (SECURITY.ADMIN_RATE_LIMIT).
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
  // En-tête absent ou répété (tableau) : refus sans comparaison
  const provided = req.headers['x-admin-key'];
  if (typeof provided !== 'string' || !crypto.timingSafeEqual(digest(provided), digest(adminKey))) {
    res.status(401).json({ error: 'Unauthorized: valid x-admin-key header required' });
    return;
  }
  next();
};

export { requireAdminKey };
