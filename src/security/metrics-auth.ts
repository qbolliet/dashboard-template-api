// Contrôle d'accès à /metrics : clé admin ou liste d'adresses autorisées
import crypto from 'crypto';
import { BlockList, isIP } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../utils/config-loader.js';

/** Address matcher built from a METRICS.ALLOWED_IPS list. */
type IpMatcher = (ip: string | undefined) => boolean;

// Préfixe d'une IPv4 reçue sur une socket double pile (::ffff:10.0.0.1)
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Normalizes a client address for comparison.
 *
 * @param ip - Address as given by Express (`req.ip`).
 * @returns The address with an IPv4-mapped IPv6 form turned back into IPv4.
 */
// Forme IPv4 d'une adresse IPv4-mappée, adresse inchangée sinon
const normalizeIp = (ip: string): string => IPV4_MAPPED.exec(ip)?.[1] ?? ip;

/**
 * Normalizes the METRICS.ALLOWED_IPS setting into a list of entries.
 *
 * Accepts a YAML list, a JSON-array string (the form an environment override
 * takes) or a comma-separated string, like TRUSTED_PROXIES.
 *
 * @param raw - Value as loaded from the configuration.
 * @returns The trimmed, non-empty entries.
 * @throws {Error} When the value is not a list or holds a non-string entry.
 */
// Liste d'entrées issue d'une liste YAML, d'une chaîne JSON ou d'une liste à virgules
const toEntries = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) return [];

  let list: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text);
      } catch {
        throw new Error(`METRICS_ALLOWED_IPS: invalid JSON array: ${raw}`);
      }
    } else {
      list = text === '' ? [] : text.split(',');
    }
  }
  if (!Array.isArray(list)) {
    throw new Error('METRICS_ALLOWED_IPS: expected a list of IPs or CIDR blocks');
  }
  return list.map((item) => {
    if (typeof item !== 'string') {
      throw new Error(`METRICS_ALLOWED_IPS: invalid entry ${JSON.stringify(item)}`);
    }
    return item.trim();
  });
};

/**
 * Builds the address matcher of the METRICS.ALLOWED_IPS setting.
 *
 * Entries are IPs or CIDR blocks (IPv4 or IPv6). An invalid entry throws, so a
 * typo stops the server at startup instead of silently leaving the list empty.
 * An empty list matches no address.
 *
 * @param raw - METRICS.ALLOWED_IPS value as loaded from the configuration.
 * @returns A function telling whether an address is on the list.
 * @throws {Error} When the value or one of its entries is invalid.
 */
// Comparateur d'adresses : IP isolée ou bloc CIDR, validés au démarrage
const createIpMatcher = (raw: unknown): IpMatcher => {
  const list = new BlockList();
  for (const entry of toEntries(raw)) {
    const [address, prefix, ...rest] = entry.split('/');
    const version = isIP(address ?? '');
    const family = version === 6 ? 'ipv6' : 'ipv4';
    const maxPrefix = version === 6 ? 128 : 32;
    if (rest.length > 0 || version === 0 || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) {
      throw new Error(
        `METRICS_ALLOWED_IPS: invalid entry "${entry}" (expected an IP or CIDR block)`,
      );
    }
    if (prefix === undefined) {
      list.addAddress(address as string, family);
    } else if (Number(prefix) <= maxPrefix) {
      list.addSubnet(address as string, Number(prefix), family);
    } else {
      throw new Error(`METRICS_ALLOWED_IPS: invalid entry "${entry}" (prefix above ${maxPrefix})`);
    }
  }

  return (ip) => {
    if (!ip) return false;
    const normalized = normalizeIp(ip);
    const version = isIP(normalized);
    return version !== 0 && list.check(normalized, version === 6 ? 'ipv6' : 'ipv4');
  };
};

/**
 * Compares two secrets in constant time, whatever their length.
 *
 * @param a - First secret.
 * @param b - Second secret.
 * @returns True when both are equal.
 */
// Comparaison sur condensés SHA-256 : même taille, aucune fuite par la durée
const safeEqual = (a: string, b: string): boolean =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a).digest(),
    crypto.createHash('sha256').update(b).digest(),
  );

/** Injectable dependencies of the metrics access guard (tests). */
interface MetricsAccessOptions {
  /** Raw METRICS.ALLOWED_IPS value; defaults to the SECURITY.METRICS configuration. */
  allowedIps?: unknown;
  /** Limiter applied to the callers who must prove themselves with the key. */
  rateLimit?: RequestHandler;
}

/**
 * Builds the guard of `/metrics`.
 *
 * A caller whose address (`req.ip`, resolved through `trust proxy`) is on
 * METRICS.ALLOWED_IPS passes straight. Any other caller must send the
 * `x-admin-key` header matching ADMIN_API_KEY, after the optional rate limiter
 * (each attempt counts, which bounds the search for the key). Without a valid
 * key the answer is a 401, including when ADMIN_API_KEY is unset: the endpoint
 * stays closed unless the operator opens it.
 *
 * @param options - Injectable dependencies.
 * @returns The Express middleware.
 * @throws {Error} When METRICS.ALLOWED_IPS is invalid.
 */
const createMetricsAccess = (options: MetricsAccessOptions = {}): RequestHandler => {
  const isAllowed = createIpMatcher(options.allowedIps ?? config.SECURITY?.METRICS?.ALLOWED_IPS);

  // Vérification de la clé admin, après le limiteur
  const checkKey = (req: Request, res: Response, next: NextFunction): void => {
    const adminKey = process.env.ADMIN_API_KEY;
    // En-tête absent ou répété (tableau) : refus sans comparaison
    const provided = req.headers['x-admin-key'];
    if (!adminKey || typeof provided !== 'string' || !safeEqual(provided, adminKey)) {
      res.status(401).json({ error: 'Unauthorized: valid x-admin-key header required' });
      return;
    }
    next();
  };

  return (req, res, next) => {
    if (isAllowed(req.ip)) {
      next();
      return;
    }
    if (!options.rateLimit) {
      checkKey(req, res, next);
      return;
    }
    options.rateLimit(req, res, (err?: unknown) => {
      if (err) next(err);
      else checkKey(req, res, next);
    });
  };
};

export { createMetricsAccess, createIpMatcher };
export type { MetricsAccessOptions };
