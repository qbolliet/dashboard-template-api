// Importation de la bibliothèque de filtrage XSS
import xss from 'xss';
import type { IFilterXSSOptions } from 'xss';
import { GraphQLError } from 'graphql';
import { createContextLogger } from '../utils/logger.js';
import type { ContextLogger } from '../utils/logger.js';

// ─── Interface de configuration ──────────────────────────────────────────────

/** Configuration interne normalisée du sanitizer. */
interface InputSanitizerConfig {
    enableXSS: boolean;
    enableSQL: boolean;
    maxStringLength: number;
    allowedTags: string[];
    customSanitizers: Record<string, (value: unknown) => unknown>;
}

// ─── Classe de sanitisation ──────────────────────────────────────────────────

/**
 * Sanitizes and validates all user inputs entering the GraphQL layer.
 *
 * Handles XSS filtering, SQL comment detection, numeric range enforcement,
 * and maximum string length. Processes nested objects and arrays recursively.
 */
class InputSanitizer {
    private config: InputSanitizerConfig;
    private logger: ContextLogger;
    private xssOptions: IFilterXSSOptions;

    /**
     * Initializes the sanitizer from the SANITIZATION section of the config.
     *
     * Args:
     *     sanitizationConfig: Raw sanitization configuration from YAML.
     */
    constructor(sanitizationConfig: Partial<Record<string, unknown>> = {}) {
        // Normalisation de la configuration avec les valeurs par défaut
        this.config = {
            enableXSS:        (sanitizationConfig['ENABLE_XSS']        as boolean)  !== false,
            enableSQL:        (sanitizationConfig['ENABLE_SQL']        as boolean)  !== false,
            maxStringLength:  (sanitizationConfig['MAX_STRING_LENGTH'] as number)   ?? 1000,
            allowedTags:      (sanitizationConfig['ALLOWED_TAGS']      as string[]) ?? [],
            customSanitizers: (sanitizationConfig['CUSTOM_SANITIZERS'] as Record<string, (v: unknown) => unknown>) ?? {}
        };

        // Initialisation du logger contextuel
        this.logger = createContextLogger({ component: 'security', module: 'sanitizer' });

        // Construction de la liste blanche XSS à partir des tags autorisés
        this.xssOptions = {
            whiteList: this.config.allowedTags.reduce<Record<string, string[]>>((acc, tag) => {
                acc[tag] = [];
                return acc;
            }, {}),
            stripIgnoreTag:     true,
            stripIgnoreTagBody: ['script', 'style']
        };
    }

    /**
     * Sanitizes all fields of an input value recursively.
     *
     * Arrays are processed element by element; objects are processed field
     * by field, applying custom sanitizers when configured.
     *
     * Args:
     *     input: Value to sanitize (primitive, array, or plain object).
     *
     * Returns:
     *     Sanitized value preserving the original structure.
     */
    sanitizeAll(input: unknown): unknown {
        if (input === null || input === undefined) {
            return input;
        }

        // Traitement récursif des tableaux
        if (Array.isArray(input)) {
            return input.map((item) => this.sanitizeAll(item));
        }

        if (typeof input === 'object') {
            const sanitized: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
                // Application d'un sanitizer personnalisé si défini pour ce champ
                if (this.config.customSanitizers[key]) {
                    sanitized[key] = this.config.customSanitizers[key](value);
                } else {
                    sanitized[key] = this.sanitizeValue(value, key);
                }
            }
            return sanitized;
        }

        return this.sanitizeValue(input);
    }

    /**
     * Sanitizes a single value based on its runtime type.
     *
     * Args:
     *     value: Value to sanitize.
     *     fieldName: Field name used in error messages.
     *
     * Returns:
     *     Sanitized value.
     *
     * Raises:
     *     GraphQLError: When the value violates a length or format constraint.
     */
    sanitizeValue(value: unknown, fieldName: string = 'unknown'): unknown {
        if (value === null || value === undefined) {
            return value;
        }

        // Traitement des chaînes de caractères
        if (typeof value === 'string') {
            // Vérification de la longueur maximale autorisée
            if (value.length > this.config.maxStringLength) {
                throw new GraphQLError(`Field ${fieldName} exceeds maximum length`, {
                    extensions: {
                        code:      'INPUT_TOO_LONG',
                        field:     fieldName,
                        maxLength: this.config.maxStringLength
                    }
                });
            }

            let sanitized = value;

            // Filtrage des attaques XSS
            if (this.config.enableXSS) {
                sanitized = this.sanitizeXSS(sanitized);
            }

            // Détection des séquences de commentaires SQL
            if (this.config.enableSQL) {
                sanitized = this.sanitizeSQL(sanitized);
            }

            return sanitized;
        }

        // Validation des nombres
        if (typeof value === 'number') {
            return this.sanitizeNumber(value, fieldName);
        }

        // Valeur booléenne — aucune transformation nécessaire
        if (typeof value === 'boolean') {
            return value;
        }

        // Objet ou tableau imbriqué — délégation récursive
        if (typeof value === 'object') {
            return this.sanitizeAll(value);
        }

        return value;
    }

    /**
     * Applies XSS filtering using the configured tag whitelist.
     *
     * Args:
     *     input: Raw string to filter.
     *
     * Returns:
     *     XSS-safe string.
     */
    private sanitizeXSS(input: string): string {
        return xss(input, this.xssOptions);
    }

    /**
     * Detects SQL comment sequences (-- and /*) and rejects the input.
     *
     * Primary SQL injection protection relies on DuckDB prepared statements
     * in pool.js. This method only targets comment sequences that cannot
     * appear legitimately in analytical values.
     *
     * Args:
     *     input: String to inspect.
     *
     * Returns:
     *     The original string when no forbidden sequence is found.
     *
     * Raises:
     *     GraphQLError: When a SQL comment sequence is detected.
     */
    private sanitizeSQL(input: string): string {
        if (/--|\/\*/.test(input)) {
            // Journalisation de la tentative d'injection
            this.logger.security('SQL comment sequence detected in input', {
                input: input.substring(0, 50) + '...'
            });
            throw new GraphQLError('Invalid input detected', {
                extensions: { code: 'SQL_INJECTION_PREVENTED' }
            });
        }
        return input;
    }

    /**
     * Validates that a number is finite and within the safe integer range.
     *
     * Args:
     *     value: Number to validate.
     *     fieldName: Field name used in error messages.
     *
     * Returns:
     *     The validated number.
     *
     * Raises:
     *     GraphQLError: When the number is infinite, NaN, or out of safe range.
     */
    private sanitizeNumber(value: number, fieldName: string): number {
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
export type { InputSanitizerConfig };
