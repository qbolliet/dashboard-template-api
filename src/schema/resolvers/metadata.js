// Importation des modules
import { withTimeout } from '../../utils/timeout.js';

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
        5000,
        'Metadata fetch timeout'
      );
    }
  }
};

export { metadataResolvers };