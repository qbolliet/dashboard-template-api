// Middleware Express de limitation de taux — rejet au plus tôt, avant tout parsing
// GraphQL ou accès à la base : une requête refusée doit coûter le minimum.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createContextLogger } from '../utils/logger.js';
import type { RateLimiter, HttpRequest } from './rate-limiter.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Options accepted by the rate-limit middleware factory. */
interface RateLimitMiddlewareOptions {
  /** Set to false to let every request through (test/dev configurations). */
  enabled?: boolean;
}

/** JSON body returned when a client exceeds its rate limit. */
interface RateLimitErrorBody {
  error: string;
  retryAfterMs: number;
}

// ─── Fabrique du middleware ─────────────────────────────────────────────────

/**
 * Builds an Express middleware enforcing the given rate limiter.
 *
 * Mount it on a route prefix *before* any expensive handler — the GraphQL
 * middleware or the export endpoint — so that a rejected request never reaches
 * query parsing or the database. The same limiter instance should be shared by
 * every protected route, so that one client consumes a single budget.
 *
 * @param rateLimiter - Shared limiter instance holding the per-client counters.
 * @param options - Optional switch disabling enforcement entirely.
 * @returns Express request handler replying 429 when the limit is exceeded.
 */
const createRateLimitMiddleware = (
  rateLimiter: RateLimiter,
  options: RateLimitMiddlewareOptions = {},
): RequestHandler => {
  const enabled = options.enabled ?? true;
  const logger = createContextLogger({ component: 'security', module: 'rate-limit-middleware' });

  return (req: Request, res: Response, next: NextFunction): void => {
    // Court-circuit complet lorsque la limitation est désactivée par configuration
    if (!enabled) {
      next();
      return;
    }

    rateLimiter
      .checkLimit(req as unknown as HttpRequest)
      .then((decision) => {
        const { info } = decision;

        // Exposition des compteurs au client (absents lorsque la requête est ignorée)
        if (!info.skip) {
          res.set('X-RateLimit-Limit', String(info.limit));
          res.set('X-RateLimit-Remaining', String(info.remaining));
          res.set('X-RateLimit-Reset', info.reset);
        }

        if (decision.allowed) {
          next();
          return;
        }

        // Rejet immédiat — Retry-After en secondes (RFC 9110), délai exact en ms dans le corps
        const body: RateLimitErrorBody = {
          error: 'Too many requests',
          retryAfterMs: decision.retryAfterMs,
        };
        res.set('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        res.status(429).json(body);
      })
      .catch((err: unknown) => {
        // Défaillance interne du limiteur — passage en mode ouvert plutôt que de
        // renvoyer une 500 sur du trafic légitime ; l'incident est journalisé.
        logger.security('Rate limit check failed, allowing request', {
          error: (err as Error).message,
        });
        next();
      });
  };
};

export { createRateLimitMiddleware };
export type { RateLimitMiddlewareOptions, RateLimitErrorBody };
