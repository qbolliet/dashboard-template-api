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
    getMetaData: async (_, { name }, { loaders }) => {
      return withTimeout(
        loaders.metadata.load(name),
        config.API.TIMEOUTS.METADATA,
        'Metadata fetch timeout'
      );
    }
  }
};

export { metadataResolvers };