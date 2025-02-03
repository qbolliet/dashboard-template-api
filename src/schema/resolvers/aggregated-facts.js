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
            limit = 100,
            offset = 0,
            sort = []
        }, { loaders }) => {
            // Validation des opérations d'agrégation
            const validAggregations = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE'];
            if (!validAggregations.includes(aggregation)) {
                throw new ValidationError(
                    `Invalid aggregation type. Must be one of: ${validAggregations.join(', ')}`
                );
            }

            // Groupby est un élément obligatoire
            if (!groupBy) {
                throw new ValidationError('groupBy field is required');
            }
            
            // Définition d'un offset valide
            if (offset > 1000) {
                throw new ValidationError('Offset cannot exceed 1000');
            }

            // Définition d'une limite valide
            if (limit > 1000) {
                throw new ValidationError('Limit cannot exceed 1000');
            }

            // Validation des champs sur lesquels trier et des opérations de tri
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
                        limit,
                        offset,
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