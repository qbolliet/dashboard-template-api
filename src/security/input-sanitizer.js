// Importation des modules
import xss from 'xss';
import { GraphQLError } from 'graphql';
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
            maxStringLength: config.MAX_STRING_LENGTH || config.SECURITY.SECURITY_LIMITS.MAX_INPUT_LENGTH,
            allowedTags: config.ALLOWED_TAGS || [],
            customSanitizers: config.CUSTOM_SANITIZERS || {}
        };
        
        // Initialisation du logger
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
     * @param {any} input - Valeur à nettoyer
     * @returns {any} Valeur nettoyée
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
                } else {
                    // Vérification de chaque valeur sinon
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
     * @param {any} value - Valeur à nettoyer
     * @param {string} fieldName - Nom du champ (pour les messages d'erreur)
     * @returns {any} Valeur nettoyée
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

    // Méthode de protection XSS
    /**
     * Protection contre les attaques XSS
     * @param {string} input - Chaîne à nettoyer
     * @returns {string} Chaîne nettoyée
     */
    sanitizeXSS(input) {
        return xss(input, this.xssOptions);
    }

    // Méthode de protection contre les injections SQL
    /**
     * Protection contre les injections SQL
     * Détecte uniquement les séquences de commentaires SQL (-- et /*) qui ne peuvent pas
     * apparaître légitimement dans des valeurs analytiques. La protection principale repose
     * sur les prepared statements DuckDB (bindVarchar/bindInteger) dans pool.js.
     * @param {string} input - Chaîne à vérifier
     * @returns {string} Chaîne inchangée si valide
     */
    sanitizeSQL(input) {
        if (/--|\/\*/.test(input)) {
            this.logger.security('SQL comment sequence detected in input', {
                input: input.substring(0, 50) + '...'
            });
            throw new GraphQLError('Invalid input detected', {
                extensions: { code: 'SQL_INJECTION_PREVENTED' }
            });
        }
        return input;
    }

    // Méthode de sanitization des nombres
    /**
     * Sanitize et valide les nombres
     * @param {number} value - Nombre à valider
     * @param {string} fieldName - Nom du champ
     * @returns {number} Nombre validé
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
}

export { InputSanitizer };