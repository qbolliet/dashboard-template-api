// Importation des modules
import { createContextLogger } from '../utils/logger.js';

// Classe d'analyse de la complexité des requêtes SQL
/**
 * Analyseur de complexité des requêtes GraphQL
 * Calcule un score de complexité basé sur la profondeur et les opérations
 */
class QueryComplexityAnalyzer {
    // Initialisation
    constructor(config = {}) {
        // Initialisation de la configuration
        this.config = {
            maxAllowed: config.MAX_ALLOWED || 100,
            scalarCost: config.SCALAR_COST || 0,
            objectCost: config.OBJECT_COST || 1,
            listFactor: config.LIST_FACTOR || 10,
            depthFactor: config.DEPTH_FACTOR || 1.5,
            introspectionCost: config.INTROSPECTION_COST || 1000,
            customScores: config.CUSTOM_SCORES || {}
        };
        // Initialisation du logger
        this.logger = createContextLogger({ component: 'security', module: 'complexity' });
    }

    // Méthode de calcul de la complexité
    /**
     * Calcule la complexité d'une requête GraphQL
     * @param {Object} info - GraphQL ResolveInfo
     * @returns {number} Score de complexité
     */
    calculate(info) {
        if (!info || !info.fieldNodes || !info.fieldNodes[0]) {
            return 0;
        }
        // Extraction de champ
        const fieldNode = info.fieldNodes[0];
        // Calcul de la complexité du champ
        const complexity = this.calculateFieldComplexity(
            fieldNode,
            info.schema,
            info.fragments,
            info.variableValues,
            0
        );
        // Logging
        this.logger.debug('Query complexity calculated', {
            field: info.fieldName,
            complexity,
            maxAllowed: this.config.maxAllowed
        });

        return complexity;
    }

    // Méthode de calcul de la complexité d'un champ
    /**
     * Calcule récursivement la complexité d'un champ
     */
    calculateFieldComplexity(node, schema, fragments, variables, depth) {
        // Initialisation
        let complexity = 0;

        // Coût de base selon le type de champ
        if (node.name?.value?.startsWith('__')) {
            // Introspection
            complexity += this.config.introspectionCost;
        } else if (this.config.customScores[node.name?.value]) {
            // Score personnalisé
            complexity += this.config.customScores[node.name.value];
        } else {
            // Coût par défaut
            complexity += this.config.objectCost;
        }

        // Facteur de profondeur
        complexity *= Math.pow(this.config.depthFactor, depth);

        // Analyse des arguments (filtres, pagination, etc.)
        if (node.arguments && node.arguments.length > 0) {
            complexity += this.calculateArgumentsComplexity(node.arguments, variables);
        }

        // Récursion sur les sélections enfants
        if (node.selectionSet) {
            node.selectionSet.selections.forEach(selection => {
                if (selection.kind === 'Field') {
                    complexity += this.calculateFieldComplexity(
                        selection,
                        schema,
                        fragments,
                        variables,
                        depth + 1
                    );
                } else if (selection.kind === 'InlineFragment') {
                    complexity += this.calculateFieldComplexity(
                        selection,
                        schema,
                        fragments,
                        variables,
                        depth
                    );
                } else if (selection.kind === 'FragmentSpread' && fragments) {
                    const fragment = fragments[selection.name.value];
                    if (fragment) {
                        complexity += this.calculateFieldComplexity(
                            fragment,
                            schema,
                            fragments,
                            variables,
                            depth
                        );
                    }
                }
            });
        }

        return complexity;
    }

    // Méthode de calcul de la complexité des arguments
    /**
     * Calcule la complexité des arguments
     */
    calculateArgumentsComplexity(args, variables) {
        // Initialisation
        let complexity = 0;
        // Parcours des arguments
        args.forEach(arg => {
            // Extraction du nom de l'argument et de sa valeur
            const argName = arg.name.value;
            let value = arg.value;

            // Résolution des variables
            if (value.kind === 'Variable' && variables) {
                value = variables[value.name.value];
            }

            // Augmentation de la complexité selon le type d'argument
            if (argName === 'limit' || argName === 'first') {
                const limit = this.extractNumericValue(value);
                complexity += Math.min(limit, 100) * 0.1; // Limiter l'impact
            } else if (argName === 'filters' || argName === 'where') {
                complexity += 2; // Coût fixe pour les filtres
            } else if (argName === 'orderBy' || argName === 'sort') {
                complexity += 1; // Coût pour le tri
            }
        });

        return complexity;
    }

    // Méthode d'extraction d'une valeur numérique d'un noeud
    /**
     * Extrait une valeur numérique d'un nœud AST
     */
    extractNumericValue(node) {
        if (node.kind === 'IntValue') {
            return parseInt(node.value, 10);
        } else if (node.kind === 'FloatValue') {
            return parseFloat(node.value);
        } else if (typeof node === 'number') {
            return node;
        }
        return 0;
    }
}

export { QueryComplexityAnalyzer };