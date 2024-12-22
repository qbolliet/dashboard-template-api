// Importation des modules
const { withTimeout } = require('../../utils/timeout');

// Construction d'un resolver pour les dimensions
const dimensionResolvers = {
    Query: {
        getDimensionTable: async (_, { name }, { loaders }) => {
            return withTimeout(
                loaders.dimension.load(name),
                5000,
                'Dimension table fetch timeout'
            );
        }
    }
};

exports.dimensionResolvers = dimensionResolvers;