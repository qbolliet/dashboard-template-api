// Importation des types et classes GraphQL pour la validation AST
import { GraphQLError } from 'graphql';
import type {
    ValidationContext,
    ASTVisitor,
    FieldNode,
    InlineFragmentNode,
    FragmentDefinitionNode,
    OperationDefinitionNode
} from 'graphql';
import { config } from '../utils/config-loader.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Union des nœuds AST possédant un ensemble de sélections potentiel. */
type SelectableNode =
    | FieldNode
    | InlineFragmentNode
    | FragmentDefinitionNode
    | OperationDefinitionNode;

// ─── Fonctions de calcul de profondeur ──────────────────────────────────────

/**
 * Recursively computes the maximum depth of a GraphQL AST node.
 *
 * Follows field selections to find the deepest nesting level. Inline
 * fragments stay at the same depth; named fragment spreads are resolved
 * via the validation context.
 *
 * Args:
 *     node: AST node to inspect (operation, field, or fragment).
 *     context: Validation context used to resolve named fragments.
 *     currentDepth: Depth accumulated by the caller.
 *
 * Returns:
 *     Maximum depth found in this node and all its descendants.
 */
const calculateNodeDepth = (
    node: SelectableNode,
    context: ValidationContext,
    currentDepth: number = 0
): number => {
    // Absence de sélections — retour de la profondeur courante
    if (!node?.selectionSet) {
        return currentDepth;
    }

    // Calcul de la profondeur maximale parmi toutes les sélections enfants
    const depths = node.selectionSet.selections.map((selection) => {
        switch (selection.kind) {
            case 'Field':
                // Champ ordinaire — incrémentation de la profondeur
                return calculateNodeDepth(selection, context, currentDepth + 1);

            case 'InlineFragment':
                // Fragment inline — même niveau de profondeur
                return calculateNodeDepth(selection, context, currentDepth);

            case 'FragmentSpread': {
                // Fragment nommé — résolution puis analyse récursive
                const fragment = context.getFragment(selection.name.value);
                return fragment
                    ? calculateNodeDepth(fragment, context, currentDepth)
                    : currentDepth;
            }

            default:
                return currentDepth;
        }
    });

    return Math.max(...depths, currentDepth);
};

// ─── Règles de validation ────────────────────────────────────────────────────

/**
 * Creates a GraphQL validation rule that rejects queries exceeding a depth limit.
 *
 * Depth is computed recursively across the full operation, including named
 * and inline fragments. Use this rule when you need accurate depth tracking.
 *
 * Args:
 *     maxDepth: Maximum allowed nesting depth for any operation.
 *
 * Returns:
 *     A validation rule function compatible with Apollo Server.
 *
 * Raises:
 *     Error: When maxDepth is not a positive integer.
 */
const createDepthLimitRule = (
    maxDepth: number = config.SECURITY_LIMITS?.DEFAULT_DEPTH_LIMIT ?? 5
): ((context: ValidationContext) => ASTVisitor) => {
    // Validation du paramètre de profondeur maximale
    if (maxDepth < 1 || !Number.isInteger(maxDepth)) {
        throw new Error('maxDepth must be a positive integer');
    }

    return (context: ValidationContext): ASTVisitor => ({
        Document(node) {
            // Analyse de chaque définition d'opération dans le document
            node.definitions
                .filter((def): def is OperationDefinitionNode => def.kind === 'OperationDefinition')
                .forEach((operation) => {
                    // Calcul de la profondeur réelle de l'opération
                    const depth = calculateNodeDepth(operation, context);

                    if (depth > maxDepth) {
                        context.reportError(
                            new GraphQLError(
                                `Query depth of ${depth} exceeds maximum allowed depth of ${maxDepth}`,
                                {
                                    nodes: [operation],
                                    extensions: {
                                        code:        'DEPTH_LIMIT_EXCEEDED',
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

/**
 * Creates a simpler depth-limit rule using a field-level entry/leave stack.
 *
 * Less accurate than createDepthLimitRule for queries with fragments, but
 * has lower per-validation overhead. Suitable for simple query shapes.
 *
 * Args:
 *     maxDepth: Maximum allowed nesting depth for any field.
 *
 * Returns:
 *     A validation rule function compatible with Apollo Server.
 *
 * Raises:
 *     Error: When maxDepth is not a positive integer.
 */
const createSimpleDepthLimitRule = (
    maxDepth: number = config.SECURITY_LIMITS?.DEFAULT_DEPTH_LIMIT ?? 5
): ((context: ValidationContext) => ASTVisitor) => {
    // Validation du paramètre de profondeur maximale
    if (maxDepth < 1 || !Number.isInteger(maxDepth)) {
        throw new Error('maxDepth must be a positive integer');
    }

    return (context: ValidationContext): ASTVisitor => {
        // Pile de suivi de la profondeur courante (un élément par champ entré)
        const depthStack: FieldNode[] = [];

        return {
            Field: {
                enter(node: FieldNode) {
                    depthStack.push(node);

                    if (depthStack.length > maxDepth) {
                        context.reportError(
                            new GraphQLError(
                                `Query depth of ${depthStack.length} exceeds maximum allowed depth of ${maxDepth}`,
                                {
                                    nodes: [node],
                                    extensions: {
                                        code:        'DEPTH_LIMIT_EXCEEDED',
                                        maxDepth,
                                        actualDepth: depthStack.length
                                    }
                                }
                            )
                        );
                    }
                },
                leave() {
                    depthStack.pop();
                }
            }
        };
    };
};

export { createDepthLimitRule, createSimpleDepthLimitRule };
export type { SelectableNode };
