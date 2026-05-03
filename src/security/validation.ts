// Importation de GraphQLError pour le signalement des erreurs de validation
import { GraphQLError } from 'graphql';
import { config } from '../utils/config-loader.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Règle de validation pour les chaînes de caractères. */
interface StringValidationRule {
    type:       'string';
    minLength:  number;
    maxLength:  number;
    required?:  boolean;
}

/** Règle de validation pour les nombres. */
interface NumberValidationRule {
    type:      'number';
    min:       number;
    max:       number;
    required?: boolean;
}

/** Union des types de règle de validation acceptés. */
type ValidationRule = StringValidationRule | NumberValidationRule;

// ─── Règles prédéfinies ───────────────────────────────────────────────────────

/**
 * Predefined validation rules for the most common input types.
 *
 * STRING uses the VALIDATION_MAX_LENGTH threshold from API configuration.
 * NUMBER uses JavaScript's safe integer boundaries.
 */
const ValidationRules = {
    STRING: {
        type:      'string' as const,
        minLength: 0,
        maxLength: config.API.SECURITY_THRESHOLDS?.VALIDATION_MAX_LENGTH ?? 500
    } satisfies StringValidationRule,

    NUMBER: {
        type: 'number' as const,
        min:  Number.MIN_SAFE_INTEGER,
        max:  Number.MAX_SAFE_INTEGER
    } satisfies NumberValidationRule
} as const;

// ─── Fonctions de validation ──────────────────────────────────────────────────

/**
 * Validates an input value against a validation rule.
 *
 * Args:
 *     input: Value to validate (any type).
 *     rules: Validation rule defining the expected type and bounds.
 *
 * Returns:
 *     The validated input value, unchanged.
 *
 * Raises:
 *     GraphQLError: When the input is missing (required), mistyped, or out of bounds.
 */
const validateInput = (
    input: unknown,
    rules: ValidationRule = ValidationRules.STRING
): unknown => {
    // Vérification de la présence pour les champs obligatoires
    if (input === null || input === undefined) {
        if (rules.required) {
            throw new GraphQLError('Input is required', {
                extensions: { code: 'REQUIRED_FIELD' }
            });
        }
        return input;
    }

    // Détermination du type effectif de l'entrée
    const inputType = Array.isArray(input) ? 'array' : typeof input;

    // Vérification de la concordance avec le type attendu
    if (inputType !== rules.type) {
        throw new GraphQLError(
            `Invalid input type. Expected ${rules.type}, got ${inputType}`,
            { extensions: { code: 'TYPE_MISMATCH' } }
        );
    }

    // Délégation à la fonction de validation spécialisée selon le type
    switch (rules.type) {
        case 'string':
            return validateString(input as string, rules as StringValidationRule);
        case 'number':
            return validateNumber(input as number, rules as NumberValidationRule);
        default:
            return input;
    }
};

/**
 * Validates a string against configured length constraints.
 *
 * Args:
 *     str: String value to validate.
 *     rules: StringValidationRule with minLength and maxLength.
 *
 * Returns:
 *     The validated string.
 *
 * Raises:
 *     GraphQLError: When the string is shorter than minLength or longer than maxLength.
 */
const validateString = (str: string, rules: StringValidationRule): string => {
    // Vérification de la longueur minimale
    if (str.length < rules.minLength) {
        throw new GraphQLError(
            `String too short. Minimum length is ${rules.minLength}`,
            { extensions: { code: 'STRING_TOO_SHORT' } }
        );
    }

    // Vérification de la longueur maximale
    if (str.length > rules.maxLength) {
        throw new GraphQLError(
            `String too long. Maximum length is ${rules.maxLength}`,
            { extensions: { code: 'STRING_TOO_LONG' } }
        );
    }

    return str;
};

/**
 * Validates a number against configured range constraints.
 *
 * Args:
 *     num: Numeric value to validate.
 *     rules: NumberValidationRule with min and max bounds.
 *
 * Returns:
 *     The validated number.
 *
 * Raises:
 *     GraphQLError: When the number is non-finite or outside the allowed range.
 */
const validateNumber = (num: number, rules: NumberValidationRule): number => {
    // Vérification de la finitude du nombre
    if (!Number.isFinite(num)) {
        throw new GraphQLError('Invalid number value', {
            extensions: { code: 'INVALID_NUMBER' }
        });
    }

    // Vérification des bornes configurées
    if (num < rules.min || num > rules.max) {
        throw new GraphQLError(
            `Number must be between ${rules.min} and ${rules.max}`,
            { extensions: { code: 'NUMBER_OUT_OF_RANGE' } }
        );
    }

    return num;
};

export { ValidationRules, validateInput };
export type { ValidationRule, StringValidationRule, NumberValidationRule };
