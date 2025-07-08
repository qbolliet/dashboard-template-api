// Importation des modules
import { withTimeout } from '../../utils/timeout.js';

// Construction de resolvers pour la table des données
/**
 * Resolvers for fact table queries
 * Handles the retrieval and formatting of fact data from the database
 */
const factResolvers = {
    Query: {
        // Requête standard des faits avec pagination et comptage
        getFactTable: async (_, args, { loaders }) => {
            return withTimeout(
                loaders.factWithCount.load(args),
                10000,
                'Fact table fetch timeout'
            );
        },
        
        // Requête des faits avec métadonnées optimisées pour D3
        getFactTableWithMetadata: async (_, args, { loaders }) => {
            return withTimeout(
                loaders.factWithMetadata.load(args),
                10000,
                'Metadata fact table fetch timeout'
            );
        }
    }
};

export { factResolvers };