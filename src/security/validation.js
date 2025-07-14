// Importation des modules
import { GraphQLError } from 'graphql';
import { config } from '../utils/config-loader.js';

// Règles de validation
const ValidationRules = {
    STRING: {
        type: 'string',
        minLength: 0,
        maxLength: config.API.SECURITY_THRESHOLDS.VALIDATION_MAX_LENGTH,
    },
    NUMBER: {
        type: 'number',
        min: Number.MIN_SAFE_INTEGER,
        max: Number.MAX_SAFE_INTEGER,
    }
};

// Fonction de validation des inputs - version simplifiée
const validateInput = (input, rules = ValidationRules.STRING) => {
    // Vérification que l'input est renseigné
    if (input === null || input === undefined) {
        if (rules.required) {
            throw new GraphQLError('Input is required', {
                extensions: { code: 'REQUIRED_FIELD' }
            });
        }
        return input;
    }

    // Type de l'input
    const inputType = Array.isArray(input) ? 'array' : typeof input;
    
    // Vérification de la concordance avec le type attendu
    if (inputType !== rules.type) {
        throw new GraphQLError(`Invalid input type. Expected ${rules.type}, got ${inputType}`, {
            extensions: { code: 'TYPE_MISMATCH' }
        });
    }

    // Validation selon le type
    switch (rules.type) {
        case 'string':
            return validateString(input, rules);
        case 'number':
            return validateNumber(input, rules);
        default:
            return input;
    }
};

// Fonction auxiliaire de validation des chaînes de caractères
const validateString = (str, rules) => {
    // Vérification de la longueur
    if (str.length < rules.minLength) {
        throw new GraphQLError(
            `String too short. Minimum length is ${rules.minLength}`,
            { extensions: { code: 'STRING_TOO_SHORT' } }
        );
    }
    
    if (str.length > rules.maxLength) {
        throw new GraphQLError(
            `String too long. Maximum length is ${rules.maxLength}`,
            { extensions: { code: 'STRING_TOO_LONG' } }
        );
    }
    
    return str;
};

// Fonction auxiliaire de validation des nombres
const validateNumber = (num, rules) => {
    if (!Number.isFinite(num)) {
        throw new GraphQLError('Invalid number value', {
            extensions: { code: 'INVALID_NUMBER' }
        });
    }
    
    if (num < rules.min || num > rules.max) {
        throw new GraphQLError(
            `Number must be between ${rules.min} and ${rules.max}`,
            { extensions: { code: 'NUMBER_OUT_OF_RANGE' } }
        );
    }
    
    return num;
};

export { ValidationRules, validateInput };