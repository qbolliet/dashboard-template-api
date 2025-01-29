// Importation des modules
const { withTimeout } = require('../../utils/timeout');
const { ValidationError } = require('apollo-server');

// Resolver pour les données agrégées
const aggregatedFactsResolvers = {
    Query: {
        getAggregatedFacts: async (_, {
            indicator,
            filters,
            structuredFilters,
            groupBy,
            aggregation = 'SUM',
            sort = []
        }, { loaders }) => {
            // Validate inputs
            const validAggregations = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE'];
            if (!validAggregations.includes(aggregation)) {
                throw new ValidationError(
                    `Invalid aggregation type. Must be one of: ${validAggregations.join(', ')}`
                );
            }

            if (!groupBy) {
                throw new ValidationError('groupBy field is required');
            }

            // Validate sort fields
            sort.forEach(({ field, order }) => {
                if (field !== 'key' && field !== 'aggregatedValue') {
                    throw new ValidationError(
                        'Sort field must be either "key" or "aggregatedValue"'
                    );
                }
                if (!['ASC', 'DESC'].includes(order)) {
                    throw new ValidationError('Sort order must be either "ASC" or "DESC"');
                }
            });

            try {
                return await withTimeout(
                    loaders.aggregatedFacts.load({
                        indicator,
                        filters,
                        structuredFilters,
                        groupBy,
                        aggregation,
                        sort
                    }),
                    10000,
                    'Aggregated facts fetch timeout'
                );
            } catch (error) {
                if (error.message === 'Aggregated facts fetch timeout') {
                    throw error;
                }
                throw new Error('Failed to fetch aggregated facts');
            }
        }
    }
};

module.exports = { aggregatedFactsResolvers };