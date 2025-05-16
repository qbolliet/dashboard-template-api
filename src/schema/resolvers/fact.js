// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { getFactTableWithCount } from '../../loaders/fact.js';

// Construction de resolvers pour la table des données
/**
 * Resolvers for fact table queries
 * Handles the retrieval and formatting of fact data from the database
 */
const factResolvers = {
    Query: {
        getFactTable: async (_, args, { loaders }) => {
            return withTimeout(
                getFactTableWithCount(args),
                10000,
                'Fact table fetch timeout'
            );
        },
        
        getFactTableWithMetadata: async (_, args, { loaders }) => {
            // Format spécifique pour D3 avec métadonnées optimisées pour visualisation
            const metadataArgs = { ...args, format: 'metadata' };
            
            return withTimeout(
                getFactTableWithCount(metadataArgs),
                10000,
                'Metadata fact table fetch timeout'
            );
        }
    }
};

export { factResolvers };