// Importation des modules
const { withTimeout } = require('../../utils/timeout');

// Construction d'un resolver pour les méta-données
const metadataResolvers = {
  Query: {
    getMetaData: async (_, { name, fields }, { loaders }) => {
      return withTimeout(
        loaders.metadata.load(name, fields),
        5000,
        'Metadata fetch timeout'
      );
    }
  }
};

exports.metadataResolvers = metadataResolvers;