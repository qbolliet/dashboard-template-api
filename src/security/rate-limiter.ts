// Importation des modules Node.js et GraphQL
import { GraphQLError } from 'graphql';
import crypto from 'crypto';
import { createContextLogger } from '../utils/logger.js';
import type { ContextLogger } from '../utils/logger.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Minimal representation of an HTTP request required by the rate limiter. */
interface HttpRequest {
    ip?: string;
    connection?: { remoteAddress?: string };
    socket?:     { remoteAddress?: string };
    headers: Record<string, string | string[] | undefined>;
}

/** Normalized internal configuration for the rate limiter. */
interface RateLimiterConfig {
    maxRequests:        number;
    windowMs:           number;
    maxBurstRequests:   number;
    burstWindowMs:      number;
    skipFailedRequests: boolean;
    keyGenerator:       (req: HttpRequest) => string;
    skip:               (req: HttpRequest) => boolean;
    trustedProxies:     Set<string>;
}

/** Tracking data associated with a client entry in the store. */
interface ClientData {
    requests:       number[];
    burstCount:     number;
    lastBurstReset: number;
    violations:     number;
}

/** Rate-limit information returned after a successful limit check. */
interface RateLimitInfo {
    limit:          number;
    remaining:      number;
    reset:          string;
    burstLimit:     number;
    burstRemaining: number;
    burstReset:     string;
    skip?:          boolean;
}

// ─── Classe de limitation de taux ───────────────────────────────────────────

/**
 * Implements a sliding-window rate limiter for GraphQL requests.
 *
 * Tracks requests per client in memory using a key derived from the
 * client's IP address and User-Agent header. Enforces both a sustained
 * request limit over a long window and a burst limit over a short window.
 */
class RateLimiter {
    private config:          RateLimiterConfig;
    private store:           Map<string, ClientData>;
    private logger:          ContextLogger;
    private cleanupInterval: ReturnType<typeof setInterval> | null;

    /**
     * Initializes the rate limiter from the RATE_LIMIT section of the config.
     *
     * @param rateLimitConfig - Raw rate-limit configuration from YAML.
     */
    constructor(rateLimitConfig: Partial<Record<string, unknown>> = {}) {
        // Normalisation de la configuration avec les valeurs par défaut
        this.config = {
            maxRequests:        (rateLimitConfig['MAX_REQUESTS']        as number)                          ?? 100,
            windowMs:           (rateLimitConfig['WINDOW_MS']           as number)                          ?? 15 * 60 * 1000,
            maxBurstRequests:   (rateLimitConfig['MAX_BURST_REQUESTS']  as number)                          ?? 20,
            burstWindowMs:      (rateLimitConfig['BURST_WINDOW_MS']     as number)                          ?? 60 * 1000,
            skipFailedRequests: (rateLimitConfig['SKIP_FAILED_REQUESTS'] as boolean)                        ?? false,
            keyGenerator:       (rateLimitConfig['KEY_GENERATOR']       as (req: HttpRequest) => string)   ?? this.defaultKeyGenerator.bind(this),
            skip:               (rateLimitConfig['SKIP']                as (req: HttpRequest) => boolean)  ?? (() => false),
            // Ensemble des IPs de proxy autorisées à transmettre x-forwarded-for
            trustedProxies:     new Set<string>((rateLimitConfig['TRUSTED_PROXIES'] as string[]) ?? [])
        };

        // Initialisation du store en mémoire
        this.store           = new Map();
        // Initialisation du logger contextuel
        this.logger          = createContextLogger({ component: 'security', module: 'rate-limiter' });
        // Démarrage du nettoyage périodique des entrées expirées
        this.cleanupInterval = setInterval(() => this._removeExpiredEntries(), this.config.windowMs);
    }

    /**
     * Checks and updates rate-limit counters for a given HTTP request.
     *
     * @param req - Incoming HTTP request to evaluate.
     * @returns RateLimitInfo with current counters and ISO reset timestamps.
     * @throws {GraphQLError} When the sustained or burst limit is exceeded.
     */
    async checkLimit(req: HttpRequest): Promise<RateLimitInfo> {
        // Court-circuit si la requête doit être ignorée
        if (this.config.skip(req)) {
            return { skip: true } as RateLimitInfo;
        }

        const key = this.config.keyGenerator(req);
        const now = Date.now();

        // Récupération ou initialisation des données du client
        let clientData = this.store.get(key);
        if (!clientData) {
            clientData = {
                requests:       [],
                burstCount:     0,
                lastBurstReset: now,
                violations:     0
            };
            this.store.set(key, clientData);
        }

        // Suppression des entrées hors de la fenêtre glissante
        clientData.requests = clientData.requests.filter(
            (timestamp) => now - timestamp < this.config.windowMs
        );

        // Réinitialisation du compteur de rafale si la fenêtre est expirée
        if (now - clientData.lastBurstReset > this.config.burstWindowMs) {
            clientData.burstCount    = 0;
            clientData.lastBurstReset = now;
        }

        // Calcul des compteurs restants
        const totalRequests  = clientData.requests.length;
        const remaining      = Math.max(0, this.config.maxRequests     - totalRequests);
        const burstRemaining = Math.max(0, this.config.maxBurstRequests - clientData.burstCount);

        // Construction de l'objet d'information de rate limit
        const rateLimitInfo: RateLimitInfo = {
            limit:          this.config.maxRequests,
            remaining,
            reset:          new Date(now + this.config.windowMs).toISOString(),
            burstLimit:     this.config.maxBurstRequests,
            burstRemaining,
            burstReset:     new Date(clientData.lastBurstReset + this.config.burstWindowMs).toISOString()
        };

        // Vérification des dépassements de limite
        if (totalRequests >= this.config.maxRequests || clientData.burstCount >= this.config.maxBurstRequests) {
            clientData.violations++;

            // Journalisation de la violation (clé partiellement masquée pour la sécurité)
            this.logger.security('Rate limit exceeded', {
                key:          key.substring(0, 8) + '...',
                totalRequests,
                burstCount:   clientData.burstCount,
                violations:   clientData.violations
            });

            // Calcul du délai avant nouvelle tentative autorisée
            const oldestRequest = clientData.requests[0] ?? now;
            const retryAfter    = Math.ceil(
                Math.min(
                    this.config.windowMs   - (now - oldestRequest),
                    this.config.burstWindowMs - (now - clientData.lastBurstReset)
                ) / 1000
            );

            throw new GraphQLError('Too many requests', {
                extensions: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    retryAfter,
                    ...rateLimitInfo
                }
            });
        }

        // Enregistrement de la requête courante dans la fenêtre
        clientData.requests.push(now);
        clientData.burstCount++;

        return rateLimitInfo;
    }

    /**
     * Generates a rate-limit store key from the client's IP and User-Agent.
     *
     * Trusts x-forwarded-for only when the connecting IP is listed in
     * trustedProxies, preventing IP spoofing by arbitrary clients.
     *
     * @param req - Incoming HTTP request.
     * @returns SHA-256 hex hash of "{ip}:{user-agent}".
     */
    private defaultKeyGenerator(req: HttpRequest): string {
        const remoteIp = req.connection?.remoteAddress ?? req.socket?.remoteAddress ?? 'unknown';
        let ip         = req.ip ?? remoteIp;

        // Lecture de x-forwarded-for uniquement depuis un proxy de confiance
        const trustedProxies = this.config.trustedProxies;
        if (trustedProxies.has(remoteIp) || trustedProxies.has('*')) {
            const forwarded = req.headers['x-forwarded-for'];
            if (forwarded) {
                const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
                ip = raw.split(',')[0].trim();
            }
        }

        const userAgent = (req.headers['user-agent'] as string | undefined) ?? 'no-user-agent';

        return crypto
            .createHash('sha256')
            .update(`${ip}:${userAgent}`)
            .digest('hex');
    }

    /**
     * Removes all store entries whose request timestamps have all expired.
     *
     * Called automatically on the periodic cleanup interval.
     */
    private _removeExpiredEntries(): void {
        const now     = Date.now();
        let   cleaned = 0;

        for (const [key, data] of this.store.entries()) {
            if (data.requests.every((timestamp) => now - timestamp > this.config.windowMs)) {
                this.store.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.logger.operation(`Rate limiter cleanup: removed ${cleaned} expired entries`);
        }
    }

    /**
     * Stops the cleanup interval and clears all stored client data.
     */
    async stop(): Promise<void> {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.store.clear();
    }

    /**
     * Public alias for stop(), provided for interface compatibility.
     */
    async cleanup(): Promise<void> {
        return this.stop();
    }
}

export { RateLimiter };
export type { HttpRequest, RateLimiterConfig, ClientData, RateLimitInfo };
