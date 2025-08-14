// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';

// Construction d'un resolver pour les dimensions
/**
 * Resolvers for dimension table queries
 * Now uses the dimension loader for consistency with the architecture
 */
const dimensionResolvers = {
    Query: {
        /**
         * Gets all records from a dimension table
         * @param {Object} _ - Parent (root)
         * @param {Object} args - Query arguments
         * @param {string} args.name - Name of the dimension table
         * @param {Object} context - GraphQL context with loaders
         * @returns {Promise<Array>} Array of dimension records
         */
        getDimensionTable: async (_, { name, database }, { loaders, getLoadersForDatabase }) => {
            // Get appropriate loader for the database
            const targetLoaders = getLoadersForDatabase(database);
            const loader = targetLoaders ? targetLoaders.dimension : loaders.dimension;
            
            // Utilisation du loader au lieu d'un accès direct à la base
            return withTimeout(
                loader.load(name),
                config.API.TIMEOUTS.DIMENSION,
                'Dimension table fetch timeout'
            );
        }
    }
};

export { dimensionResolvers };