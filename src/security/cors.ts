// Middleware CORS — origines explicitement listées, aucun credential, préflight court-circuité
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../utils/config-loader.js';
import type { CorsConfig } from '../utils/config-loader.js';

// ─── Résolution des origines ──────────────────────────────────────────────────

/**
 * Normalizes the CORS_ORIGINS setting into a list of allowed origins.
 *
 * Accepts a YAML list (development, config/api.yaml), a JSON-array string —
 * the form the `CORS_ORIGINS` environment override takes in production, e.g.
 * `CORS_ORIGINS='["https://qbolliet.github.io"]'` — or a comma-separated
 * string. Empty or absent resolves to no allowed origin at all: a missing
 * `CORS_ORIGINS` in production refuses every cross-origin request rather than
 * silently allowing one.
 *
 * @param raw - CORS.ORIGINS value as loaded from the configuration.
 * @returns The validated list of allowed origins.
 * @throws {Error} When a JSON-looking value is not a valid JSON array.
 */
// Normalisation de CORS_ORIGINS (liste YAML, chaîne JSON ou liste à virgules)
export function parseCorsOrigins(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof raw !== 'string') return [];

  const text = raw.trim();
  if (text === '') return [];
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`CORS_ORIGINS: invalid JSON array: ${raw}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`CORS_ORIGINS: expected a JSON array, got: ${raw}`);
    }
    return parsed.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// ─── Middleware ────────────────────────────────────────────────────────────────

/**
 * Builds the CORS middleware.
 *
 * The request's `Origin` is echoed back in `Access-Control-Allow-Origin`
 * (never a wildcard) only when it is in the allow-list resolved from
 * `settings.ORIGINS`; every other origin gets no such header, so the browser
 * blocks the response. `Vary: Origin` keeps a downstream cache from serving
 * one origin's response to another. `OPTIONS` preflight requests are answered
 * directly with 204 and never reach the GraphQL/REST handlers.
 *
 * @param settings - CORS configuration; defaults to API.CORS of config/api.yaml.
 * @returns Express middleware setting CORS headers and answering preflight.
 */
// Construction du middleware CORS à partir de la configuration
export function createCorsMiddleware(settings: CorsConfig = config.API.CORS): RequestHandler {
  const allowedOrigins = parseCorsOrigins(settings.ORIGINS);

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }

    res.set('Access-Control-Allow-Methods', settings.METHODS.join(', '));
    res.set('Access-Control-Allow-Headers', settings.HEADERS.join(', '));
    res.set('Access-Control-Max-Age', String(settings.MAX_AGE));
    // Aucun cookie n'est utilisé par l'API : l'en-tête n'est envoyé que si un
    // déploiement l'active explicitement (absent par défaut, cf. config/api.yaml)
    if (settings.CREDENTIALS) {
      res.set('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
