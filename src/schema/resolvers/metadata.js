// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';

// Construction d'un resolver pour les méta-données
/**
 * Resolvers for metadata queries
 * Handles the retrieval of metadata information from the database
 */
const metadataResolvers = {
  Query: {
    getMetaData: async (_, { name, database }, { loaders, getLoadersForDatabase }) => {
      // Get appropriate loader for the database (null if using default from context)
      const targetLoaders = getLoadersForDatabase(database);
      const loader = targetLoaders ? targetLoaders.metadata : loaders.metadata;
        
      return withTimeout(
        loader.load(name),
        config.API.TIMEOUTS.METADATA,
        'Metadata fetch timeout'
      );
    }
  }
};

export { metadataResolvers };