// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { GraphQLError } from 'graphql';
import { enrichAggregatedFacts } from './field-resolvers.js';
import { enrichAggregatedFactsWithLabels } from '../../utils/dimension-enrichment.js';
import { config } from '../../utils/config-loader.js';
import type { GraphQLContext } from './types.js';
import type { AggregatedQueryParams, AggregatedResult } from '../../loaders/aggregated-facts.js';
import type { StructuredFilter } from '../../utils/utils.js';
import type { AggregatedFactParent } from './field-resolvers.js';

// ─── Types d'agrégation ───────────────────────────────────────────────────────

/** Opérations d'agrégation SQL supportées. */
type AggregationType = 'SUM' | 'AVG' | 'MAX' | 'MIN' | 'COUNT' | 'MEDIAN' | 'MODE';

/** Valeurs valides pour l'ordre de tri. */
type SortOrder = 'ASC' | 'DESC';

/** Critère de tri spécifique aux requêtes agrégées. */
interface AggregatedSortItem {
    field: 'key' | 'aggregatedValue';
    order: SortOrder;
}

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments communs des requêtes getAggregatedFacts et getAggregatedFactsWithMetadata. */
interface AggregatedFactsArgs {
    fields?: string[];
    filters?: string | null;
    structuredFilters?: StructuredFilter[] | null;
    groupBy: string;
    aggregation?: AggregationType;
    limit?: number;
    offset?: number;
    sort?: AggregatedSortItem[];
    database?: string | null;
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** Résultat agrégé avec métadonnées (utilisé par getAggregatedFactsWithMetadata). */
interface AggregatedWithMetadataResult {
    data: AggregatedFactParent[];
    [key: string]: unknown;
}

// ─── Constantes de validation ─────────────────────────────────────────────────

/** Liste exhaustive des opérations d'agrégation supportées. */
const VALID_AGGREGATIONS: readonly AggregationType[] = [
    'SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE'
];

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Validates pagination and aggregation arguments for aggregated fact queries.
 *
 * Centralises argument validation to avoid duplication between the two
 * aggregated fact resolvers.
 *
 * Args:
 *     aggregation: Aggregation type to validate.
 *     groupBy: Group-by field (must be non-empty).
 *     offset: Pagination offset to validate.
 *     limit: Pagination limit to validate.
 *     sort: Sort items to validate (field and order).
 *
 * Raises:
 *     GraphQLError: When any argument fails validation.
 */
// Validation centralisée des arguments des requêtes agrégées
function validateAggregatedArgs(
    aggregation: AggregationType,
    groupBy: string | undefined,
    offset: number,
    limit: number,
    sort: AggregatedSortItem[]
): void {
    // Validation des opérations d'agrégation
    if (!VALID_AGGREGATIONS.includes(aggregation)) {
        throw new GraphQLError(
            `Invalid aggregation type. Must be one of: ${VALID_AGGREGATIONS.join(', ')}`
        );
    }

    // Groupby est un élément obligatoire
    if (!groupBy) {
        throw new GraphQLError('groupBy field is required');
    }

    // Validation de l'offset de pagination
    if (offset > config.API.PAGINATION.MAX_OFFSET) {
        throw new GraphQLError(`Offset cannot exceed ${config.API.PAGINATION.MAX_OFFSET}`);
    }

    // Validation de la limite de pagination
    if (limit > config.API.PAGINATION.MAX_LIMIT) {
        throw new GraphQLError(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
    }

    // Validation des champs sur lesquels trier et des opérations de tri
    sort.forEach(({ field, order }) => {
        if (field !== 'key' && field !== 'aggregatedValue') {
            throw new GraphQLError('Sort field must be either "key" or "aggregatedValue"');
        }
        if (!['ASC', 'DESC'].includes(order)) {
            throw new GraphQLError('Sort order must be either "ASC" or "DESC"');
        }
    });
}

// Resolver pour les données agrégées
/**
 * Resolvers for aggregated fact queries.
 *
 * Supports flexible grouping, multiple aggregation functions, sorting,
 * pagination, and optional D3 metadata enrichment. Results are enriched
 * with human-readable labels for categorical group-by dimensions.
 */
const aggregatedFactsResolvers = {
    Query: {
        /**
         * Fetches aggregated facts grouped by a dimension field.
         *
         * Validates all arguments, loads aggregated data via DataLoader,
         * then enriches every row with its groupBy field and keyLabel.
         *
         * Args:
         *     _: Parent resolver result (unused at root).
         *     args: Aggregation query parameters.
         *     context: GraphQL context with loaders.
         *
         * Returns:
         *     Array of enriched aggregated fact rows.
         *
         * Raises:
         *     GraphQLError: When validation fails or the loader times out.
         */
        getAggregatedFacts: async (
            _: unknown,
            {
                fields,
                filters,
                structuredFilters,
                groupBy,
                aggregation = 'SUM',
                limit = config.API.PAGINATION.DEFAULT_LIMIT,
                offset = 0,
                sort = [],
                database
            }: AggregatedFactsArgs,
            { loaders, getLoadersForDatabase }: GraphQLContext
        ) => {
            // Validation centralisée des paramètres de la requête
            validateAggregatedArgs(aggregation, groupBy, offset, limit, sort);

            try {
                const targetLoaders = getLoadersForDatabase(database);
                const activeLoaders = targetLoaders ?? loaders;

                const results = await withTimeout(
                    activeLoaders.aggregatedFacts.load({
                        fields,
                        filters,
                        structuredFilters,
                        groupBy,
                        aggregation,
                        limit,
                        offset,
                        sort
                    } as AggregatedQueryParams),
                    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                    'Aggregated facts fetch timeout'
                ) as unknown as AggregatedFactParent[];

                // Enrichissement des résultats avec le champ de regroupement
                // et chargement en masse des labels
                const enrichedResults = enrichAggregatedFacts(results, groupBy);
                return await withTimeout(
                    enrichAggregatedFactsWithLabels(enrichedResults, groupBy, activeLoaders),
                    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                    'Aggregated facts labels enrichment timeout'
                );
            } catch (error) {
                if ((error as Error).message === 'Aggregated facts fetch timeout') {
                    throw error;
                }
                throw new Error('Failed to fetch aggregated facts');
            }
        },

        /**
         * Fetches aggregated facts with D3-compatible metadata.
         *
         * Applies the same validation and enrichment as getAggregatedFacts,
         * but also returns axis extents and statistics for chart configuration.
         *
         * Args:
         *     _: Parent resolver result (unused at root).
         *     args: Aggregation query parameters.
         *     context: GraphQL context with loaders.
         *
         * Returns:
         *     Object with enriched data array and D3 metadata.
         *
         * Raises:
         *     GraphQLError: When validation fails or the loader times out.
         */
        getAggregatedFactsWithMetadata: async (
            _: unknown,
            {
                fields,
                filters,
                structuredFilters,
                groupBy,
                aggregation = 'SUM',
                limit = config.API.PAGINATION.DEFAULT_LIMIT,
                offset = 0,
                sort = [],
                database
            }: AggregatedFactsArgs,
            { loaders, getLoadersForDatabase }: GraphQLContext
        ) => {
            // Validation centralisée des paramètres de la requête
            validateAggregatedArgs(aggregation, groupBy, offset, limit, sort);

            try {
                const targetLoaders = getLoadersForDatabase(database);
                const activeLoaders = targetLoaders ?? loaders;

                const result = await withTimeout(
                    activeLoaders.aggregatedFactsWithMetadata.load({
                        fields,
                        filters,
                        structuredFilters,
                        groupBy,
                        aggregation,
                        limit,
                        offset,
                        sort
                    } as AggregatedQueryParams),
                    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                    'Aggregated facts with metadata fetch timeout'
                ) as unknown as AggregatedWithMetadataResult;

                // Enrichissement des données avec le champ de regroupement
                // et chargement en masse des labels
                const enrichedData = enrichAggregatedFacts(result.data, groupBy);
                result.data = await withTimeout(
                    enrichAggregatedFactsWithLabels(enrichedData, groupBy, activeLoaders),
                    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                    'Aggregated facts labels enrichment timeout'
                );

                return result;
            } catch (error) {
                if ((error as Error).message === 'Aggregated facts fetch timeout') {
                    throw error;
                }
                throw new Error('Failed to fetch aggregated facts');
            }
        }
    }
};

export { aggregatedFactsResolvers };
