// Importation des modules
const { GraphQLError } = require('graphql');

// Règles de validation
const ValidationRules = {
    STRING: {
        type: 'string',
        minLength: 0,
        maxLength: 500,
    },
    NUMBER: {
        type: 'number',
        min: Number.MIN_SAFE_INTEGER,
        max: Number.MAX_SAFE_INTEGER,
    },
    ARRAY: {
        type: 'array',
        minItems: 0,
        maxItems: 1000,
        blacklist : null,
        whitelist : null,
        pattern : null,
        itemType: null,
        itemShape: 1000
    },
    FILTERS: {
        type: 'array',
        minItems: 0,
        maxItems: 50,
        itemType: 'object',
        itemShape: {
            key: 'string',
            operator: ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN'],
            value: 'any'
        }
    },
    SORT: {
        type: 'array',
        minItems: 0,
        maxItems: 10,
        itemType: 'object',
        itemShape: {
            field: 'string',
            order: ['ASC', 'DESC']
        }
    }
};

// Fonction de validation des input
function validateInput(input, rules = ValidationRules.STRING) {
    // Vérification que l'input est renseigné
    if (input === null || input === undefined) {
        if (rules.required) {
            throw new GraphQLError('Input is required');
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

    // Validation suivant chaque type
    if (rules.type === 'array') {
        validateArray(input, rules);
    } else if (rules.type === 'string') {
        validateString(input, rules);
    } else if (rules.type === 'number') {
        validateNumber(input, rules);
    }

    return input;
}

// Fonction auxiliaire de validation des array
function validateArray(array, rules) {
    // Validation de la longueur
    if (input.length < rules.minItems) {
        throw new GraphQLError(`Input too short. Minimum length is ${rules.minItems}`, {
            extensions: { code: 'LENGTH_ERROR' }
        });
    }

    if (input.length > rules.maxItems) {
        throw new GraphQLError(`Input too long. Maximum length is ${rules.maxItems}`, {
            extensions: { code: 'LENGTH_ERROR' }
        });
    }

    // Validation des patterns
    if (rules.pattern && !rules.pattern.test(input)) {
        throw new GraphQLError('Input does not match required pattern', {
            extensions: { code: 'PATTERN_MISMATCH' }
        });
    }

    // Validation des strings autorisées
    if (rules.whitelist && !rules.whitelist.includes(input)) {
        throw new GraphQLError('Input not in allowed values', {
            extensions: { code: 'WHITELIST_ERROR' }
        });
    }

    // Validation des strings interdites
    if (rules.blacklist && rules.blacklist.includes(input)) {
        throw new GraphQLError('Input contains disallowed value', {
            extensions: { code: 'BLACKLIST_ERROR' }
        });
    }

    // Vérification des types de chaque élément
    if (rules.itemType) {
        array.forEach((item, index) => {
            const itemType = Array.isArray(item) ? 'array' : typeof item;
            if (itemType !== rules.itemType) {
                throw new GraphQLError(`Invalid item type at index ${index}`, {
                    extensions: { code: 'TYPE_ERROR' }
                });
            }
            // Vérification de la taille de chaque élément
            if (rules.itemShape) {
                validateShape(item, rules.itemShape, index);
            }
        });
    }
}

// Fonction auxiliaire de validation des chaînes de caractère
function validateString(str, rules) {
    // Vérification de la longueur de la chaîne de caractère
    if (str.length < rules.minLength || str.length > rules.maxLength) {
        throw new GraphQLError(`String length must be between ${rules.minLength} and ${rules.maxLength}`);
    }
}

// Fonction auxiliaire de validation des nombres
function validateNumber(num, rules) {
    if (num < rules.min || num > rules.max) {
        throw new GraphQLError(`Number must be between ${rules.min} and ${rules.max}`);
    }
}

// Fonction auxiliaire de validation des dimensions
function validateShape(object, shape, index) {
    for (const [key, allowed] of Object.entries(shape)) {
        if (!object[key]) {
            throw new GraphQLError(`Missing required field '${key}' at index ${index}`);
        }
        if (Array.isArray(allowed) && !allowed.includes(object[key])) {
            throw new GraphQLError(`Invalid value for '${key}' at index ${index}`);
        }
        if (typeof allowed === 'string' && typeof object[key] !== allowed) {
            throw new GraphQLError(`Invalid type for '${key}' at index ${index}`);
        }
    }
}

module.exports = {
    ValidationRules,
    validateInput
};