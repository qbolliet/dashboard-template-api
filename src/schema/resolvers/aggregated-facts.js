// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { GraphQLError } from 'graphql';
import { enrichAggregatedFacts } from './field-resolvers.js';
import { enrichAggregatedFactsWithLabels } from '../../utils/dimension-enrichment.js';
import { config } from '../../utils/config-loader.js';

// Resolver pour les données agrégées
const aggregatedFactsResolvers = {
    Query: {
        getAggregatedFacts: async (_, {
            fields,
            filters,
            structuredFilters,
            groupBy,
            aggregation = 'SUM',
            limit = config.API.PAGINATION.DEFAULT_LIMIT,
            offset = 0,
            sort = [],
            database
        }, { loaders, getLoadersForDatabase }) => {
            // Validation des opérations d'agrégation
            const validAggregations = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE'];
            if (!validAggregations.includes(aggregation)) {
                throw new GraphQLError(
                    `Invalid aggregation type. Must be one of: ${validAggregations.join(', ')}`
                );
            }

            // Groupby est un élément obligatoire
            if (!groupBy) {
                throw new GraphQLError('groupBy field is required');
            }
            
            // Définition d'un offset valide
            if (offset > config.API.PAGINATION.MAX_OFFSET) {
                throw new GraphQLError(`Offset cannot exceed ${config.API.PAGINATION.MAX_OFFSET}`);
            }

            // Définition d'une limite valide
            if (limit > config.API.PAGINATION.MAX_LIMIT) {
                throw new GraphQLError(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
            }

            // Validation des champs sur lesquels trier et des opérations de tri
            sort.forEach(({ field, order }) => {
                if (field !== 'key' && field !== 'aggregatedValue') {
                    throw new GraphQLError(
                        'Sort field must be either "key" or "aggregatedValue"'
                    );
                }
                if (!['ASC', 'DESC'].includes(order)) {
                    throw new GraphQLError('Sort order must be either "ASC" or "DESC"');
                }
            });

            try {
                const targetLoaders = getLoadersForDatabase(database);
                const activeLoaders = targetLoaders || loaders;

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
                    }),
                    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                    'Aggregated facts fetch timeout'
                );

                // Enrichissement des résultats avec le champ de regroupement
                // et chargement en masse des labels
                const enrichedResults = enrichAggregatedFacts(results, groupBy);
                return await withTimeout(
                    enrichAggregatedFactsWithLabels(enrichedResults, groupBy, activeLoaders),
                    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                    'Aggregated facts labels enrichment timeout'
                );
            } catch (error) {
                if (error.message === 'Aggregated facts fetch timeout') {
                    throw error;
                }
                throw new Error('Failed to fetch aggregated facts');
            }
        },

        getAggregatedFactsWithMetadata: async (_, {
            fields,
            filters,
            structuredFilters,
            groupBy,
            aggregation = 'SUM',
            limit = config.API.PAGINATION.DEFAULT_LIMIT,
            offset = 0,
            sort = [],
            database
        }, { loaders, getLoadersForDatabase }) => {
            // Validation des opérations d'agrégation
            const validAggregations = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE'];
            if (!validAggregations.includes(aggregation)) {
                throw new GraphQLError(
                    `Invalid aggregation type. Must be one of: ${validAggregations.join(', ')}`
                );
            }

            // Groupby est un élément obligatoire
            if (!groupBy) {
                throw new GraphQLError('groupBy field is required');
            }
            
            // Définition d'un offset valide
            if (offset > config.API.PAGINATION.MAX_OFFSET) {
                throw new GraphQLError(`Offset cannot exceed ${config.API.PAGINATION.MAX_OFFSET}`);
            }

            // Définition d'une limite valide
            if (limit > config.API.PAGINATION.MAX_LIMIT) {
                throw new GraphQLError(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
            }

            // Validation des champs sur lesquels trier et des opérations de tri
            sort.forEach(({ field, order }) => {
                if (field !== 'key' && field !== 'aggregatedValue') {
                    throw new GraphQLError(
                        'Sort field must be either "key" or "aggregatedValue"'
                    );
                }
                if (!['ASC', 'DESC'].includes(order)) {
                    throw new GraphQLError('Sort order must be either "ASC" or "DESC"');
                }
            });
            
            try {
                const targetLoaders = getLoadersForDatabase(database);
                const activeLoaders = targetLoaders || loaders;

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
                    }),
                    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                    'Aggregated facts with metadata fetch timeout'
                );

                // Enrichissement les données avec le champ de regroupement
                // et chargement en masse des labels
                const enrichedData = enrichAggregatedFacts(result.data, groupBy);
                result.data = await withTimeout(
                    enrichAggregatedFactsWithLabels(enrichedData, groupBy, activeLoaders),
                    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                    'Aggregated facts labels enrichment timeout'
                );

                return result;
            } catch (error) {
                if (error.message === 'Aggregated facts fetch timeout') {
                    throw error;
                }
                throw new Error('Failed to fetch aggregated facts');
            }
        }
    }
};

export { aggregatedFactsResolvers };