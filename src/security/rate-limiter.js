// Importation des modules
import { GraphQLError } from 'graphql';
import crypto from 'crypto';
import { createContextLogger } from '../utils/logger.js';

// Calsse de gestion de la fréquence des requêtes
/**
 * Gestionnaire de limitation de taux
 * Implémente un système de limitation par fenêtre glissante
 */
class RateLimiter {
    // Initialisation
    constructor(config = {}) {
        // Initialisation de la configuration
        this.config = {
            maxRequests: config.MAX_REQUESTS || 100,
            windowMs: config.WINDOW_MS || 15 * 60 * 1000, // 15 minutes
            maxBurstRequests: config.MAX_BURST_REQUESTS || 20,
            burstWindowMs: config.BURST_WINDOW_MS || 60 * 1000, // 1 minute
            skipFailedRequests: config.SKIP_FAILED_REQUESTS || false,
            keyGenerator: config.KEY_GENERATOR || this.defaultKeyGenerator,
            skip: config.SKIP || (() => false),
            // Liste des IPs de proxy de confiance (ex: '127.0.0.1', '10.0.0.0/8')
            // Seules ces IPs sont autorisées à transmettre x-forwarded-for
            trustedProxies: new Set(config.TRUSTED_PROXIES || [])
        };
        // Initialisation du stockage
        this.store = new Map();
        // Initialisation du logger
        this.logger = createContextLogger({ component: 'security', module: 'rate-limiter' });
        
        // Nettoyage périodique des entrées expirées
        this.cleanupInterval = setInterval(() => this._removeExpiredEntries(), this.config.windowMs);
    }

    // Méthode de vérification que la limite n'est pas atteinte
    /**
     * Vérifie et met à jour les limites de taux
     * @param {Request} req - Requête Express
     * @returns {Object} Informations sur le rate limit
     */
    async checkLimit(req) {
        // Vérification si on doit ignorer cette requête
        if (this.config.skip(req)) {
            return { skip: true };
        }

        const key = this.config.keyGenerator(req);
        const now = Date.now();
        
        // Récupération ou initialisation des données du client
        let clientData = this.store.get(key);
        if (!clientData) {
            clientData = {
                requests: [],
                burstCount: 0,
                lastBurstReset: now,
                violations: 0
            };
            this.store.set(key, clientData);
        }

        // Nettoyage des anciennes requêtes
        clientData.requests = clientData.requests.filter(
            timestamp => now - timestamp < this.config.windowMs
        );

        // Réinitialisation du compteur de burst si nécessaire
        if (now - clientData.lastBurstReset > this.config.burstWindowMs) {
            clientData.burstCount = 0;
            clientData.lastBurstReset = now;
        }

        // Calcul des limites
        const totalRequests = clientData.requests.length;
        const remaining = Math.max(0, this.config.maxRequests - totalRequests);
        const burstRemaining = Math.max(0, this.config.maxBurstRequests - clientData.burstCount);
        
        // Création des headers de rate limit
        const rateLimitInfo = {
            limit: this.config.maxRequests,
            remaining,
            reset: new Date(now + this.config.windowMs).toISOString(),
            burstLimit: this.config.maxBurstRequests,
            burstRemaining,
            burstReset: new Date(clientData.lastBurstReset + this.config.burstWindowMs).toISOString()
        };

        // Vérification des violations
        if (totalRequests >= this.config.maxRequests || 
            clientData.burstCount >= this.config.maxBurstRequests) {
            
            clientData.violations++;
            
            // Log de la violation
            this.logger.security('Rate limit exceeded', {
                key: key.substring(0, 8) + '...', // Log partiel pour la sécurité
                totalRequests,
                burstCount: clientData.burstCount,
                violations: clientData.violations
            });

            // Calcul du temps d'attente
            const retryAfter = Math.ceil(
                Math.min(
                    this.config.windowMs - (now - clientData.requests[0]),
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

        // Ajout de la requête actuelle
        clientData.requests.push(now);
        clientData.burstCount++;

        return rateLimitInfo;
    }

    // Méthode de génération de clé
    /**
     * Générateur de clé par défaut basé sur IP et User-Agent.
     * Ne fait confiance à x-forwarded-for que si l'IP de connexion est dans trustedProxies.
     */
    defaultKeyGenerator(req) {
        const remoteIp = req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';

        let ip = req.ip || remoteIp;

        // Utiliser x-forwarded-for uniquement si le proxy est de confiance
        const trustedProxies = this.config.trustedProxies;
        if (trustedProxies.has(remoteIp) || trustedProxies.has('*')) {
            const forwarded = req.headers['x-forwarded-for'];
            if (forwarded) {
                ip = forwarded.split(',')[0].trim();
            }
        }

        const userAgent = req.headers['user-agent'] || 'no-user-agent';

        return crypto
            .createHash('sha256')
            .update(`${ip}:${userAgent}`)
            .digest('hex');
    }

    // Supprime les entrées expirées du store (appelé périodiquement par l'interval)
    _removeExpiredEntries() {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, data] of this.store.entries()) {
            if (data.requests.every(timestamp => now - timestamp > this.config.windowMs)) {
                this.store.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.logger.debug(`Rate limiter cleanup: removed ${cleaned} expired entries`);
        }
    }

    // Méthode d'arrêt du nettoyage périodique
    /**
     * Arrête le nettoyage périodique et vide le store
     */
    async stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.store.clear();
    }

    // Alias public pour la compatibilité (appelle stop)
    async cleanup() {
        return this.stop();
    }
}

export { RateLimiter };