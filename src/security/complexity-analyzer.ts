// Importation des types GraphQL nécessaires à l'analyse AST
import type {
    GraphQLResolveInfo,
    FieldNode,
    FragmentDefinitionNode,
    InlineFragmentNode,
    ArgumentNode,
    ValueNode,
    IntValueNode,
    FloatValueNode,
    GraphQLSchema
} from 'graphql';
import { createContextLogger } from '../utils/logger.js';
import { config } from '../utils/config-loader.js';
import type { ContextLogger } from '../utils/logger.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Configuration interne normalisée de l'analyseur de complexité. */
interface ComplexityAnalyzerConfig {
    maxAllowed: number;
    scalarCost: number;
    objectCost: number;
    listFactor: number;
    depthFactor: number;
    introspectionCost: number;
    customScores: Record<string, number>;
}

/** Union des nœuds AST acceptés par l'analyseur récursif. */
type ComplexityNode = FieldNode | InlineFragmentNode | FragmentDefinitionNode;

// ─── Classe d'analyse de complexité ─────────────────────────────────────────

/**
 * Analyzes the complexity of GraphQL queries.
 *
 * Computes a numeric score based on field depth, argument types, and
 * per-field custom weights loaded from configuration. The score is used
 * to reject queries that would be too expensive to execute.
 */
class QueryComplexityAnalyzer {
    private config: ComplexityAnalyzerConfig;
    private logger: ContextLogger;

    /**
     * Initializes the analyzer with values from the YAML complexity config.
     *
     * Args:
     *     complexityConfig: Raw complexity section from SECURITY.COMPLEXITY.
     */
    constructor(complexityConfig: Partial<Record<string, unknown>> = {}) {
        // Fusion des options avec les valeurs par défaut
        this.config = {
            maxAllowed:        (complexityConfig['MAX_ALLOWED']        as number) ?? 100,
            scalarCost:        (complexityConfig['SCALAR_COST']        as number) ?? 0,
            objectCost:        (complexityConfig['OBJECT_COST']        as number) ?? 1,
            listFactor:        (complexityConfig['LIST_FACTOR']        as number) ?? 10,
            depthFactor:       (complexityConfig['DEPTH_FACTOR']       as number) ?? 1.5,
            introspectionCost: (complexityConfig['INTROSPECTION_COST'] as number) ?? 1000,
            customScores:      (complexityConfig['CUSTOM_SCORES']      as Record<string, number>) ?? {}
        };
        // Initialisation du logger contextuel
        this.logger = createContextLogger({ component: 'security', module: 'complexity' });
    }

    /**
     * Calculates the complexity score for a GraphQL field resolver.
     *
     * Args:
     *     info: GraphQL resolve info for the current field.
     *
     * Returns:
     *     Numeric complexity score, or 0 when resolve info is unavailable.
     */
    calculate(info: GraphQLResolveInfo): number {
        if (!info?.fieldNodes?.[0]) {
            return 0;
        }

        // Extraction du premier nœud de champ à analyser
        const fieldNode = info.fieldNodes[0];

        // Calcul récursif depuis la racine
        const complexity = this.calculateFieldComplexity(
            fieldNode,
            info.schema,
            info.fragments as Record<string, FragmentDefinitionNode>,
            info.variableValues as Record<string, unknown>,
            0
        );

        // Journalisation du score calculé
        this.logger.operation('Query complexity calculated', {
            field:      info.fieldName,
            complexity,
            maxAllowed: this.config.maxAllowed
        });

        return complexity;
    }

    /**
     * Recursively computes the complexity contribution of an AST node.
     *
     * Args:
     *     node: AST node to analyze (field, inline fragment, or named fragment).
     *     schema: Current GraphQL schema instance.
     *     fragments: Named fragment definitions available in the document.
     *     variables: Resolved variable values for the operation.
     *     depth: Current recursion depth used for the depth cost factor.
     *
     * Returns:
     *     Cumulative complexity score for this node and all its descendants.
     */
    private calculateFieldComplexity(
        node: ComplexityNode,
        schema: GraphQLSchema,
        fragments: Record<string, FragmentDefinitionNode>,
        variables: Record<string, unknown>,
        depth: number
    ): number {
        // Initialisation du score local
        let complexity = 0;
        const nodeName = 'name' in node ? node.name?.value : undefined;

        // Coût de base selon le type de champ
        if (nodeName?.startsWith('__')) {
            // Champ d'introspection — coût intentionnellement élevé
            complexity += this.config.introspectionCost;
        } else if (nodeName && this.config.customScores[nodeName]) {
            // Score personnalisé configuré pour ce champ
            complexity += this.config.customScores[nodeName];
        } else {
            // Coût d'objet par défaut
            complexity += this.config.objectCost;
        }

        // Application du facteur de profondeur (exponentiel)
        complexity *= Math.pow(this.config.depthFactor, depth);

        // Complexité additionnelle des arguments du champ
        const args = 'arguments' in node ? (node as FieldNode).arguments : undefined;
        if (args && args.length > 0) {
            complexity += this.calculateArgumentsComplexity(args, variables);
        }

        // Récursion sur les sélections enfants
        if (node.selectionSet) {
            for (const selection of node.selectionSet.selections) {
                if (selection.kind === 'Field') {
                    complexity += this.calculateFieldComplexity(
                        selection, schema, fragments, variables, depth + 1
                    );
                } else if (selection.kind === 'InlineFragment') {
                    complexity += this.calculateFieldComplexity(
                        selection, schema, fragments, variables, depth
                    );
                } else if (selection.kind === 'FragmentSpread') {
                    const fragment = fragments[selection.name.value];
                    if (fragment) {
                        complexity += this.calculateFieldComplexity(
                            fragment, schema, fragments, variables, depth
                        );
                    }
                }
            }
        }

        return complexity;
    }

    /**
     * Calculates additional complexity from field arguments.
     *
     * Pagination limits, filters, and sort directives each carry a
     * configurable cost to reflect their execution overhead.
     *
     * Args:
     *     args: Argument AST nodes for the current field.
     *     variables: Resolved variable values for the operation.
     *
     * Returns:
     *     Complexity contribution from the given arguments.
     */
    private calculateArgumentsComplexity(
        args: readonly ArgumentNode[],
        variables: Record<string, unknown>
    ): number {
        // Initialisation du score d'arguments
        let complexity = 0;

        for (const arg of args) {
            const argName = arg.name.value;
            let value: ValueNode | unknown = arg.value;

            // Résolution des références de variables GraphQL
            if ((value as ValueNode).kind === 'Variable' && variables) {
                const varName = (value as { kind: 'Variable'; name: { value: string } }).name.value;
                value = variables[varName];
            }

            if (argName === 'limit' || argName === 'first') {
                // Coût proportionnel à la limite de pagination (plafonné à 100)
                const limit  = this.extractNumericValue(value as ValueNode | number);
                const factor = config.SECURITY_LIMITS?.COMPLEXITY_CALCULATION_FACTOR ?? 0.1;
                complexity  += Math.min(limit, 100) * factor;
            } else if (argName === 'filters' || argName === 'where') {
                // Coût fixe pour les prédicats de filtre
                complexity += 2;
            } else if (argName === 'orderBy' || argName === 'sort') {
                // Coût pour les directives de tri
                complexity += 1;
            }
        }

        return complexity;
    }

    /**
     * Extracts a numeric value from an AST value node or a plain number.
     *
     * Args:
     *     node: An AST IntValue, FloatValue node, or a plain JavaScript number.
     *
     * Returns:
     *     The numeric value, or 0 when the type is unrecognized.
     */
    private extractNumericValue(node: ValueNode | number): number {
        if (typeof node === 'number') {
            return node;
        }
        if (node.kind === 'IntValue') {
            return parseInt((node as IntValueNode).value, 10);
        }
        if (node.kind === 'FloatValue') {
            return parseFloat((node as FloatValueNode).value);
        }
        return 0;
    }
}

export { QueryComplexityAnalyzer };
export type { ComplexityAnalyzerConfig, ComplexityNode };
