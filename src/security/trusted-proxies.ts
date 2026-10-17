// Liste des proxys de confiance — source unique du réglage Express « trust proxy »
import { isIP } from 'node:net';
import { config } from '../utils/config-loader.js';

// Plages nommées reconnues par proxy-addr (module utilisé par Express pour req.ip)
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Checks one trusted-proxy entry: an IP, a CIDR block or a proxy-addr named range.
 *
 * @param entry - Trimmed entry.
 * @returns True when Express (proxy-addr) can compile the entry.
 */
// Validation d'une entrée : IP, bloc CIDR ou plage nommée
const isValidProxyEntry = (entry: string): boolean => {
  if (NAMED_RANGES.has(entry)) return true;

  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;

  // Préfixe entier borné par la taille de l'adresse
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
};

/**
 * Normalizes the TRUSTED_PROXIES setting into a value for Express `trust proxy`.
 *
 * Accepts a YAML list, a JSON-array string (`'["10.0.0.0/8"]'`, the form an
 * environment override takes) or a comma-separated string. Entries are IPs,
 * CIDR blocks or proxy-addr named ranges (`loopback`, `linklocal`,
 * `uniquelocal`); `'*'` trusts every hop. Any invalid entry throws, so a typo
 * stops the server at startup instead of silently identifying every client by
 * the ingress IP.
 *
 * @param raw - TRUSTED_PROXIES value as loaded from the configuration.
 * @returns The validated list, `true` when `'*'` is listed.
 * @throws {Error} When the value or one of its entries is invalid.
 */
// Normalisation de TRUSTED_PROXIES (liste, chaîne JSON ou liste à virgules)
const parseTrustedProxies = (raw: unknown): string[] | boolean => {
  if (raw === undefined || raw === null) return [];

  let list: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text);
      } catch {
        throw new Error(`TRUSTED_PROXIES: invalid JSON array: ${raw}`);
      }
    } else {
      list = text === '' ? [] : text.split(',');
    }
  }

  if (!Array.isArray(list)) {
    throw new Error('TRUSTED_PROXIES: expected a list of IPs or CIDR blocks');
  }

  const entries: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new Error(`TRUSTED_PROXIES: invalid entry ${JSON.stringify(item)}`);
    }
    const entry = item.trim();
    // Confiance totale : réservée à un réseau où seul le proxy peut joindre l'API
    if (entry === '*') return true;
    if (!isValidProxyEntry(entry)) {
      throw new Error(`TRUSTED_PROXIES: invalid entry "${item}" (expected an IP or CIDR block)`);
    }
    entries.push(entry);
  }
  return entries;
};

/**
 * Reads the trusted proxies of the rate limiter configuration.
 *
 * @returns Value for `app.set('trust proxy', …)`.
 * @throws {Error} When SECURITY.RATE_LIMIT.TRUSTED_PROXIES is invalid.
 */
// Valeur de « trust proxy » issue de SECURITY.RATE_LIMIT.TRUSTED_PROXIES
const configuredTrustProxy = (): string[] | boolean =>
  parseTrustedProxies(config.SECURITY?.RATE_LIMIT?.TRUSTED_PROXIES);

export { parseTrustedProxies, configuredTrustProxy };
