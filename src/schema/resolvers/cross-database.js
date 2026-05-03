import { GraphQLError } from 'graphql';
import { withTimeout } from '../../utils/timeout.js';
import { databaseManager } from '../../db/index.js';
import { config } from '../../utils/config-loader.js';

const crossDatabaseResolvers = {
    Query: {
        compareFacts: async (_, {
            databaseA,
            databaseB,
            joinFields,
            limit = config.API.PAGINATION.DEFAULT_LIMIT,
            offset = 0,
            sort = []
        }, { loaders }) => {
            if (!databaseManager.isCrossDatabaseAllowed()) {
                throw new GraphQLError(
                    'Cross-database queries are disabled. Set ALLOW_CROSS_DATABASE_QUERIES=true to enable them.',
                    { extensions: { code: 'CROSS_DATABASE_DISABLED' } }
                );
            }

            [databaseA, databaseB].forEach(db => {
                if (!databaseManager.isValidDatabase(db)) {
                    throw new GraphQLError(`Database '${db}' is not available.`);
                }
            });

            if (!joinFields || joinFields.length === 0) {
                throw new GraphQLError('At least one joinField is required');
            }

            if (limit > config.API.PAGINATION.MAX_LIMIT) {
                throw new GraphQLError(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
            }

            return withTimeout(
                loaders.compareFacts.load({ databaseA, databaseB, joinFields, limit, offset, sort }),
                config.API.TIMEOUTS.FACT_COMPLEX,
                'compareFacts timeout'
            );
        },

        compareAggregatedFacts: async (_, {
            databaseA,
            databaseB,
            groupBy,
            aggregation = 'SUM',
            limit = config.API.PAGINATION.DEFAULT_LIMIT,
            offset = 0
        }, { loaders }) => {
            if (!databaseManager.isCrossDatabaseAllowed()) {
                throw new GraphQLError(
                    'Cross-database queries are disabled. Set ALLOW_CROSS_DATABASE_QUERIES=true to enable them.',
                    { extensions: { code: 'CROSS_DATABASE_DISABLED' } }
                );
            }

            [databaseA, databaseB].forEach(db => {
                if (!databaseManager.isValidDatabase(db)) {
                    throw new GraphQLError(`Database '${db}' is not available.`);
                }
            });

            if (!groupBy) {
                throw new GraphQLError('groupBy is required');
            }

            if (limit > config.API.PAGINATION.MAX_LIMIT) {
                throw new GraphQLError(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
            }

            const validAggregations = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE'];
            if (!validAggregations.includes(aggregation)) {
                throw new GraphQLError(`Invalid aggregation. Must be one of: ${validAggregations.join(', ')}`);
            }

            return withTimeout(
                loaders.compareAggregatedFacts.load({
                    databaseA, databaseB, groupBy, aggregation, limit, offset
                }),
                config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                'compareAggregatedFacts timeout'
            );
        },

        crossDatabaseSelectOptions: async (_, {
            fieldName,
            databases,
            limit = 50
        }, { loaders }) => {
            if (!databaseManager.isCrossDatabaseAllowed()) {
                throw new GraphQLError(
                    'Cross-database queries are disabled. Set ALLOW_CROSS_DATABASE_QUERIES=true to enable them.',
                    { extensions: { code: 'CROSS_DATABASE_DISABLED' } }
                );
            }

            if (!databases || databases.length < 2) {
                throw new GraphQLError('At least two databases must be specified');
            }

            databases.forEach(db => {
                if (!databaseManager.isValidDatabase(db)) {
                    throw new GraphQLError(`Database '${db}' is not available.`);
                }
            });

            return withTimeout(
                loaders.crossDatabaseSelectOptions.load({ fieldName, databases, limit }),
                config.API.TIMEOUTS.FACT_SIMPLE,
                'crossDatabaseSelectOptions timeout'
            );
        }
    }
};

export { crossDatabaseResolvers };
