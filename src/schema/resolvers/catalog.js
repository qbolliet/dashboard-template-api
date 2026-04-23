import { GraphQLError } from 'graphql';
import { databaseManager } from '../../db/index.js';

const catalogResolvers = {
    Query: {
        getDatabases: async (_, __, { loaders }) => {
            const databases = databaseManager.getAvailableDatabases();
            return Promise.all(databases.map(async id => {
                let fields, dimensionNames;
                try {
                    fields = await loaders.catalogMetadata.load(id);
                } catch (e) {
                    fields = [];
                }
                try {
                    dimensionNames = await loaders.catalogDimensionNames.load(id);
                } catch (e) {
                    dimensionNames = [];
                }
                return { id, fields: fields || [], dimensionNames: dimensionNames || [] };
            }));
        },

        getDatabaseSchema: async (_, { database }, { loaders }) => {
            const targetDb = databaseManager.validateDatabaseRouting(database);
            return loaders.catalogMetadata.load(targetDb);
        },

        getSharedDimensions: async (_, { databases }, { loaders }) => {
            if (!databases || databases.length === 0) {
                throw new GraphQLError('At least one database must be specified');
            }

            databases.forEach(db => {
                if (!databaseManager.isValidDatabase(db)) {
                    throw new GraphQLError(
                        `Database '${db}' is not available. Available: ${databaseManager.getAvailableDatabases().join(', ')}`
                    );
                }
            });

            const dimensionSets = await Promise.all(
                databases.map(db => loaders.catalogDimensionNames.load(db))
            );

            if (dimensionSets.length === 0) return [];

            const [first, ...rest] = dimensionSets;
            return first.filter(dim => rest.every(set => set.includes(dim)));
        }
    }
};

export { catalogResolvers };
