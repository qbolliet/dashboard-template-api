// Importation des modules
import fs from 'fs';
import yaml from 'yaml';
import path from 'path';
import { fileURLToPath } from 'url';

// Extraction des chemins du fichier
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Classe de chargement de la configuration
class ConfigLoader {
    // Initialisation
    constructor() {
        this.configDir = path.resolve(__dirname, '../../config');
        this.config = null;
    }

    // Méthode de chargement de tous les fichiers de configuration
    loadConfig() {
        if (this.config) return this.config;
        // Liste des fichiers de configuration
        const configFiles = [
            'main.yaml',
            'database.yaml',
            'api.yaml',
            'cache.yaml',
            'security.yaml',
            'security-patterns.yaml',
            //'operations.yaml',
            'logging.yaml'
        ];

        this.config = {};

        // Chargement et fusion de tous les fichiers
        configFiles.forEach(file => {
            const filePath = path.join(this.configDir, file);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const parsed = yaml.parse(content);
                this.config = this.mergeDeep(this.config, parsed);
            }
        });

        // Remplacement des variables d'environnement
        this.config = this.resolveEnvVariables(this.config);

        // Application des valeurs spécifiques à l'environnement
        this.config = this.applyEnvironmentSpecific(this.config);

        // Conversion des valeurs numériques
        this.config = this.convertNumericValues(this.config);

        return this.config;
    }

    // Méthode de fusion profonde des objets
    mergeDeep(target, source) {
        const output = { ...target };
        if (this.isObject(target) && this.isObject(source)) {
            Object.keys(source).forEach(key => {
                if (this.isObject(source[key])) {
                    if (!(key in target)) {
                        output[key] = source[key];
                    } else {
                        output[key] = this.mergeDeep(target[key], source[key]);
                    }
                } else {
                    output[key] = source[key];
                }
            });
        }
        return output;
    }

    // Méthode auxiliaire de vérification si c'est un objet
    isObject(item) {
        return item && typeof item === 'object' && !Array.isArray(item);
    }

    // Méthode de résolution des variables d'environnement ${VAR:-default}
    resolveEnvVariables(obj) {
        const envPattern = /\$\{([^}]+)\}/g;
        
        const resolve = (item) => {
            if (typeof item === 'string') {
                return item.replace(envPattern, (match, envVar) => {
                    const [varName, defaultValue] = envVar.split(':-');
                    return process.env[varName] || defaultValue || match;
                });
            } else if (Array.isArray(item)) {
                return item.map(resolve);
            } else if (this.isObject(item)) {
                const resolved = {};
                Object.keys(item).forEach(key => {
                    resolved[key] = resolve(item[key]);
                });
                return resolved;
            }
            return item;
        };

        return resolve(obj);
    }

    // Méthode d'application des configurations spécifiques à l'environnement
    applyEnvironmentSpecific(config) {
        // Chargement de l'environnement
        const env = config.ENVIRONMENT || 'development';
        // Application de l'environnement
        const applyEnv = (obj) => {
            if (this.isObject(obj)) {
                // Si l'objet contient des clés d'environnement
                if (obj.development || obj.production) {
                    return obj[env] || obj.development || {};
                }
                
                // Sinon, appliquer récursivement
                const result = {};
                Object.keys(obj).forEach(key => {
                    result[key] = applyEnv(obj[key]);
                });
                return result;
            }
            return obj;
        };

        return applyEnv(config);
    }

    // Méthode de conversion automatique des valeurs numériques
    convertNumericValues(obj) {
        const convert = (item) => {
            if (typeof item === 'string') {
                // Vérifie si la chaîne représente un nombre entier
                if (/^-?\d+$/.test(item.trim())) {
                    return parseInt(item.trim(), 10);
                }
                // Vérifie si la chaîne représente un nombre décimal
                if (/^-?\d*\.\d+$/.test(item.trim())) {
                    return parseFloat(item.trim());
                }
                // Vérifie si la chaîne représente un booléen
                if (item.trim().toLowerCase() === 'true') {
                    return true;
                }
                if (item.trim().toLowerCase() === 'false') {
                    return false;
                }
                // Retourne la chaîne telle quelle si ce n'est pas un nombre
                return item;
            } else if (Array.isArray(item)) {
                return item.map(convert);
            } else if (this.isObject(item)) {
                const converted = {};
                Object.keys(item).forEach(key => {
                    converted[key] = convert(item[key]);
                });
                return converted;
            }
            return item;
        };

        return convert(obj);
    }

    // Méthode d'obtention d'une valeur de configuration avec un chemin en pointillés
    get(path, defaultValue = null) {
        // Chargement de la configuration si elle n'existe pas déjà
        if (!this.config) this.loadConfig();
        // Extraction de la valeur
        return path.split('.').reduce((obj, key) => 
            obj && obj[key] !== undefined ? obj[key] : defaultValue, 
            this.config
        );
    }
}

// Initialisation d'un loader
const configLoader = new ConfigLoader();
// Initialisation de la configuration
const config = configLoader.loadConfig();

// Export
export { configLoader, config };