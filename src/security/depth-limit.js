// Importation des modules
import { GraphQLError } from 'graphql';

// Création d'une fonction qui limite la profondeur de la requête
/**
 * Creates a GraphQL validation rule that limits query depth
 * @param {number} maxDepth - Maximum allowed query depth
 * @returns {Function} Validation rule function
 */
export function createDepthLimitRule(maxDepth = 5) {
    return function depthLimitRule(context) {
        return {
            // Validation au niveau du document
            Document(node) {
                const depths = new Map();
                
                // Fonction récursive pour calculer la profondeur
                function calculateDepth(node, currentDepth = 0) {
                    if (!node || !node.selectionSet) {
                        return currentDepth;
                    }

                    let maxChildDepth = currentDepth;

                    node.selectionSet.selections.forEach(selection => {
                        let childDepth = currentDepth;

                        if (selection.kind === 'Field') {
                            childDepth = calculateDepth(selection, currentDepth + 1);
                        } else if (selection.kind === 'InlineFragment') {
                            childDepth = calculateDepth(selection, currentDepth);
                        } else if (selection.kind === 'FragmentSpread') {
                            const fragment = context.getFragment(selection.name.value);
                            if (fragment) {
                                childDepth = calculateDepth(fragment, currentDepth);
                            }
                        }

                        maxChildDepth = Math.max(maxChildDepth, childDepth);
                    });

                    return maxChildDepth;
                }

                // Vérifier chaque opération dans le document
                node.definitions.forEach(definition => {
                    if (definition.kind === 'OperationDefinition') {
                        const depth = calculateDepth(definition);
                        
                        if (depth > maxDepth) {
                            context.reportError(
                                new GraphQLError(
                                    `Query depth of ${depth} exceeds maximum allowed depth of ${maxDepth}`,
                                    {
                                        nodes: [definition],
                                        extensions: {
                                            code: 'DEPTH_LIMIT_EXCEEDED',
                                            maxDepth,
                                            actualDepth: depth
                                        }
                                    }
                                )
                            );
                        }
                    }
                });
            }
        };
    };
}

// Création d'une fonction de vérification plus simple qui ne compte que la profondeur du champ
/**
 * Creates a simpler depth limit rule that counts field depth
 * Alternative implementation that's easier to understand
 * @param {number} maxDepth - Maximum allowed query depth
 * @returns {Function} Validation rule function
 */
export function createSimpleDepthLimitRule(maxDepth = 5) {
    return function simpleDepthLimitRule(context) {
        const depths = [];
        
        return {
            Field: {
                enter(node) {
                    depths.push(node);
                    
                    if (depths.length > maxDepth) {
                        context.reportError(
                            new GraphQLError(
                                `Query depth of ${depths.length} exceeds maximum allowed depth of ${maxDepth}`,
                                {
                                    nodes: [node],
                                    extensions: {
                                        code: 'DEPTH_LIMIT_EXCEEDED',
                                        maxDepth,
                                        actualDepth: depths.length
                                    }
                                }
                            )
                        );
                    }
                },
                leave() {
                    depths.pop();
                }
            }
        };
    };
}