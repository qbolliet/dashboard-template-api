// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { ValidationError } from 'apollo-server';
import { enrichAggregatedFacts } from './field-resolvers.js';

// Resolver pour les données agrégées
const aggregatedFactsResolvers = {
    Query: {
        getAggregatedFacts: async (_, {
            fields,
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
                const results = await withTimeout(
                    loaders.aggregatedFacts.load({
                        fields,
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
                
                // Enrichissement des résultats avec le champ de regroupement
                // pour permettre la résolution des labels
                return enrichAggregatedFacts(results, groupBy);
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
                const result = await withTimeout(
                    loaders.aggregatedFactsWithMetadata.load({
                        fields,
                        filters,
                        structuredFilters,
                        groupBy,
                        aggregation,
                        limit,
                        offset,
                        sort
                    }),
                    10000,
                    'Aggregated facts with metadata fetch timeout'
                );
                
                // Enrichissement les données avec le champ de regroupement
                result.data = enrichAggregatedFacts(result.data, groupBy);
                
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