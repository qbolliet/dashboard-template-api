// Importation des modules
import { GraphQLError } from 'graphql';

// Fonction calculant la profondeur d'un noeud
/**
 * Calcule la profondeur d'un nœud GraphQL de manière récursive
 * @param {Object} node - Nœud GraphQL à analyser
 * @param {Object} context - Contexte GraphQL
 * @param {number} currentDepth - Profondeur actuelle
 * @returns {number} Profondeur maximale trouvée
 */
const calculateNodeDepth = (node, context, currentDepth = 0) => {
    // Si pas de sélection, retourne la profondeur actuelle
    if (!node?.selectionSet) {
        return currentDepth;
    }

    // Calcul de la profondeur maximale parmi toutes les sélections
    const depths = node.selectionSet.selections.map(selection => {
        switch (selection.kind) {
            case 'Field':
                // Pour un champ, augmente la profondeur
                return calculateNodeDepth(selection, context, currentDepth + 1);
            
            case 'InlineFragment':
                // Pour un fragment inline, garde la même profondeur
                return calculateNodeDepth(selection, context, currentDepth);
            
            case 'FragmentSpread':
                // Pour un fragment spread, récupére et analyse le fragment
                const fragment = context.getFragment(selection.name.value);
                return fragment 
                    ? calculateNodeDepth(fragment, context, currentDepth)
                    : currentDepth;
            
            default:
                return currentDepth;
        }
    });

    return Math.max(...depths, currentDepth);
};


// Fonction de validation limitant la profondeur des requêtes
/**
 * Crée une règle de validation GraphQL qui limite la profondeur des requêtes
 * @param {number} maxDepth - Profondeur maximale autorisée
 * @returns {Function} Fonction de règle de validation
 */
const createDepthLimitRule = (maxDepth = 5) => {
    // Validation du paramètre
    if (maxDepth < 1 || !Number.isInteger(maxDepth)) {
        throw new Error('maxDepth must be a positive integer');
    }

    return (context) => ({
        Document: (node) => {
            // Analyse de chaque définition d'opération
            node.definitions
                .filter(def => def.kind === 'OperationDefinition')
                .forEach(operation => {
                    // Calcul de la profondeur du noeud pour chaque
                    const depth = calculateNodeDepth(operation, context);
                    
                    if (depth > maxDepth) {
                        context.reportError(
                            new GraphQLError(
                                `Query depth of ${depth} exceeds maximum allowed depth of ${maxDepth}`,
                                {
                                    nodes: [operation],
                                    extensions: {
                                        code: 'DEPTH_LIMIT_EXCEEDED',
                                        maxDepth,
                                        actualDepth: depth
                                    }
                                }
                            )
                        );
                    }
                });
        }
    });
};

// Fonction de validation simple basée sur le nombre de champs
/**
 * Crée une règle de validation simple basée sur le comptage des champs
 * Alternative plus simple mais moins précise
 * @param {number} maxDepth - Profondeur maximale autorisée
 * @returns {Function} Fonction de règle de validation
 */
const createSimpleDepthLimitRule = (maxDepth = 5) => {
    // Validation du paramètre
    if (maxDepth < 1 || !Number.isInteger(maxDepth)) {
        throw new Error('maxDepth must be a positive integer');
    }

    return (context) => {
        // Stack pour suivre la profondeur actuelle
        const depthStack = [];
        
        return {
            Field: {
                enter: (node) => {
                    depthStack.push(node);
                    
                    if (depthStack.length > maxDepth) {
                        context.reportError(
                            new GraphQLError(
                                `Query depth of ${depthStack.length} exceeds maximum allowed depth of ${maxDepth}`,
                                {
                                    nodes: [node],
                                    extensions: {
                                        code: 'DEPTH_LIMIT_EXCEEDED',
                                        maxDepth,
                                        actualDepth: depthStack.length
                                    }
                                }
                            )
                        );
                    }
                },
                leave: () => {
                    depthStack.pop();
                }
            }
        };
    };
};

export { createDepthLimitRule, createSimpleDepthLimitRule };