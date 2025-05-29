// Importation des modules
import { withTimeout } from '../../utils/timeout.js';

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

export { dimensionResolvers };