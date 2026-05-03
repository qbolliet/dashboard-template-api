// Importation des modules
import { GraphQLError } from 'graphql';
import { createContextLogger } from '../utils/logger.js';
import { config } from '../utils/config-loader.js';

// Classe de validation des patterns de requête
class PatternValidator {
    // Initialisation
    constructor() {
        // Initialisation du loader
        this.logger = createContextLogger({ component: 'security', module: 'patterns' });
        // Initialisation des patterns
        this.patterns = this.loadPatterns();
        // Compilation des patterns
        this.compiledPatterns = this.compilePatterns();
    }

    // Méthode de chargement des patterns
    /**
     * Charge les patterns depuis la configuration déjà chargée
     */
    loadPatterns() {
        try {
            const env = process.env.NODE_ENV || 'development';
            
            
            // Vérification que la configuration des patterns de sécurité existe
            if (!config.SECURITY_PATTERNS) {
                throw new Error('SECURITY_PATTERNS configuration not found');
            }
            
            // Fusion des patterns communs et spécifiques à l'environnement
            const patterns = {
                blocked: [...(config.SECURITY_PATTERNS.blocked || [])],
                allowed: [...(config.SECURITY_PATTERNS.allowed || [])]
            };


            // Logging
            this.logger.operation('Patterns loaded', {
                environment: env,
                blockedCount: patterns.blocked.length,
                allowedCount: patterns.allowed.length
            });

            return patterns;
        } catch (error) {
            // Logging
            this.logger.error('Failed to load security patterns', error);
            // Retourne des patterns par défaut en cas d'erreur
            return {
                blocked: [
                    { pattern: "mutation", message: "Mutations are not allowed", flags: "i" },
                    { pattern: "drop\\s+table", message: "DDL operations are forbidden", flags: "i" }
                ],
                allowed: []
            };
        }
    }

    // Méthode de compilation des patterns
    /**
     * Compile les patterns en expressions régulières
     */
    compilePatterns() {
        const compiled = {
            blocked: [],
            allowed: []
        };

        // Compilation des patterns bloqués
        for (const patternConfig of this.patterns.blocked) {
            try {
                compiled.blocked.push({
                    regex: new RegExp(patternConfig.pattern, patternConfig.flags || 'i'),
                    message: patternConfig.message,
                    original: patternConfig.pattern
                });
            } catch (error) {
                // Logging
                this.logger.error('Failed to compile pattern', error, {
                    pattern: patternConfig.pattern
                });
            }
        }

        // Les patterns autorisés sont des strings simples
        compiled.allowed = this.patterns.allowed;

        return compiled;
    }

    // Méthode de validation d'une requête
    /**
     * Valide une requête GraphQL contre les patterns
     */
    async validateQuery(query) {
        if (!query || typeof query !== 'string') {
            return;
        }

        // Vérification des patterns autorisés
        for (const allowed of this.compiledPatterns.allowed) {
            if (query.includes(allowed)) {
                this.logger.operation('Query contains allowed pattern', { component: 'security', module: 'patterns', pattern: allowed });
                return; // Pattern autorisé, pas de vérification supplémentaire
            }
        }

        // Vérification des patterns bloqués
        for (const { regex, message, original } of this.compiledPatterns.blocked) {
            if (regex.test(query)) {
                // Logging
                this.logger.security('Blocked pattern detected in query', {
                    pattern: original,
                    message,
                    querySnippet: query.substring(0, config.API.SECURITY_THRESHOLDS.QUERY_SNIPPET_LENGTH) + '...'
                });

                throw new GraphQLError(message, {
                    extensions: { 
                        code: 'FORBIDDEN_PATTERN',
                        pattern: original
                    }
                });
            }
        }
    }

    // Méthode de rechargement des patterns
    /**
     * Recharge les patterns (utile pour les tests ou les mises à jour)
     */
    reload() {
        this.patterns = this.loadPatterns();
        this.compiledPatterns = this.compilePatterns();
        this.logger.operation('Pattern validator reloaded');
    }
}

export { PatternValidator };