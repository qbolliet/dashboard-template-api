// Importation des modules
import xss from 'xss';
import sqlstring from 'sqlstring';
import { GraphQLError } from 'graphql';
import { ValidationRules, validateInput } from './validation.js';
import { createContextLogger } from '../utils/logger.js';

// Classe de nettoyage des entrées de l'utilisateur
/**
 * Sanitizer pour les entrées utilisateur
 * Nettoie et valide toutes les entrées
 */
class InputSanitizer {
    // Initialisation
    constructor(config = {}) {
        // Extraction de la configuration
        this.config = {
            enableXSS: config.ENABLE_XSS !== false,
            enableSQL: config.ENABLE_SQL !== false,
            maxStringLength: config.MAX_STRING_LENGTH || 1000,
            allowedTags: config.ALLOWED_TAGS || [],
            customSanitizers: config.CUSTOM_SANITIZERS || {}
        };
        // Initialisation
        this.logger = createContextLogger({ component: 'security', module: 'sanitizer' });
        
        // Configuration XSS
        this.xssOptions = {
            whiteList: this.config.allowedTags.reduce((acc, tag) => {
                acc[tag] = [];
                return acc;
            }, {}),
            stripIgnoreTag: true,
            stripIgnoreTagBody: ['script', 'style']
        };
    }

    // Méthode de vérification des entrées d'un objet
    /**
     * Sanitize toutes les entrées d'un objet
     */
    sanitizeAll(input) {
        if (input === null || input === undefined) {
            return input;
        }
        // Vérification de chaque élément d'un array
        if (Array.isArray(input)) {
            return input.map(item => this.sanitizeAll(item));
        }

        if (typeof input === 'object') {
            const sanitized = {};
            for (const [key, value] of Object.entries(input)) {
                // Application d'un sanitizer personnalisé si disponible
                if (this.config.customSanitizers[key]) {
                    sanitized[key] = this.config.customSanitizers[key](value);
                // Vérification de chaque valeur sinon
                } else {
                    sanitized[key] = this.sanitizeValue(value, key);
                }
            }
            return sanitized;
        }

        return this.sanitizeValue(input);
    }

    // Méthode de sanitization d'une valeur
    /**
     * Sanitize une valeur individuelle
     */
    sanitizeValue(value, fieldName = 'unknown') {
        if (value === null || value === undefined) {
            return value;
        }

        // Pour les strings
        if (typeof value === 'string') {
            // Vérification de la longueur
            if (value.length > this.config.maxStringLength) {
                throw new GraphQLError(`Field ${fieldName} exceeds maximum length`, {
                    extensions: { 
                        code: 'INPUT_TOO_LONG',
                        field: fieldName,
                        maxLength: this.config.maxStringLength
                    }
                });
            }

            let sanitized = value;

            // Protection XSS
            if (this.config.enableXSS) {
                sanitized = this.sanitizeXSS(sanitized);
            }

            // Protection SQL Injection
            if (this.config.enableSQL) {
                sanitized = this.sanitizeSQL(sanitized);
            }

            return sanitized;
        }

        // Pour les nombres
        if (typeof value === 'number') {
            return this.sanitizeNumber(value, fieldName);
        }

        // Pour les booléens
        if (typeof value === 'boolean') {
            return value;
        }

        // Pour les objets et arrays, récursion
        if (typeof value === 'object') {
            return this.sanitizeAll(value);
        }

        return value;
    }

    // Méthode de protection xss
    /**
     * Protection XSS
     */
    sanitizeXSS(input) {
        return xss(input, this.xssOptions);
    }

    // Méthode de protection contre les injections SQL
    /**
     * Protection SQL Injection
     */
    sanitizeSQL(input) {
        // Détection de patterns SQL dangereux
        const dangerousPatterns = [
            /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b)/i,
            /(--|\/\*|\*\/|;)/,
            /(\bor\b.*=.*)/i,
            /(\band\b.*=.*)/i
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(input)) {
                this.logger.security('SQL injection attempt detected', {
                    pattern: pattern.toString(),
                    input: input.substring(0, 50) + '...'
                });
                
                throw new GraphQLError('Invalid input detected', {
                    extensions: { code: 'SQL_INJECTION_PREVENTED' }
                });
            }
        }

        // Evite les caractères spéciaux SQL
        return sqlstring.escape(input).slice(1, -1); // Enlever les quotes ajoutées
    }

    // Méthode de sanitization des nombres
    /**
     * Sanitize les nombres
     */
    sanitizeNumber(value, fieldName) {
        if (!Number.isFinite(value)) {
            throw new GraphQLError(`Invalid number for field ${fieldName}`, {
                extensions: { code: 'INVALID_NUMBER', field: fieldName }
            });
        }

        if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
            throw new GraphQLError(`Number out of safe range for field ${fieldName}`, {
                extensions: { code: 'NUMBER_OUT_OF_RANGE', field: fieldName }
            });
        }

        return value;
    }

    // Méthode de validation selon des règles spécifiques
    /**
     * Valide et sanitize selon des règles spécifiques
     */
    validateAndSanitize(value, rules) {
        // D'abord valider
        const validated = validateInput(value, rules);
        
        // Puis sanitizer
        return this.sanitizeValue(validated);
    }
}

export { InputSanitizer };