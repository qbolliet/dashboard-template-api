// Importation des modules
import fs from 'fs';
import yaml from 'yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import { GraphQLError } from 'graphql';

// Définition des chemins
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Classe de validation des patterns de requête
class PatternValidator {
    // Initialisation
    constructor() {
        this.patterns = this.loadPatterns();
    }

    // Méthode de chargement des patterns
    loadPatterns() {
        // Chargement de la configuration
        const configPath = path.resolve(__dirname, '../../config/security-patterns.yaml');
        const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
        // Extraction de l'environnement
        const env = process.env.NODE_ENV || 'development';
        // Extraction des patterns bloqués et autorisés
        const patterns = {
            blocked: [...config.SECURITY_PATTERNS.common.blocked],
            allowed: []
        };

        // Ajout des patterns spécifiques à l'environnement
        if (config.SECURITY_PATTERNS[env]) {
            if (config.SECURITY_PATTERNS[env].blocked) {
                patterns.blocked.push(...config.SECURITY_PATTERNS[env].blocked);
            }
            if (config.SECURITY_PATTERNS[env].allowed) {
                patterns.allowed = config.SECURITY_PATTERNS[env].allowed;
            }
        }

        // Compilation des regex
        patterns.blocked = patterns.blocked.map(p => ({
            regex: new RegExp(p.pattern, p.flags || ''),
            message: p.message
        }));

        return patterns;
    }

    // Méthode de validation de la requête
    validateQuery(query) {
        // Vérification que la requête contient des patterns autorisés
        for (const allowed of this.patterns.allowed) {
            if (query.includes(allowed)) {
                return; // Pattern autorisé, pas de vérification supplémentaire
            }
        }

        // Vérification des patterns bloqués
        for (const { regex, message } of this.patterns.blocked) {
            if (regex.test(query)) {
                throw new GraphQLError(message, {
                    extensions: { code: 'FORBIDDEN_PATTERN' }
                });
            }
        }
    }
}

export const patternValidator = new PatternValidator();