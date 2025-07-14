// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { enrichFactsWithDimensions } from '../../utils/dimension-enrichment.js';
import { config } from '../../utils/config-loader.js';

// Construction de resolvers pour la table des données
/**
 * Resolvers for fact table queries
 * Handles the retrieval and formatting of fact data from the database
 */
const factResolvers = {
    Query: {
        // Requête standard des faits avec pagination et comptage
        getFactTable: async (_, args, { loaders }) => {
            const result = await withTimeout(
                loaders.factWithCount.load(args),
                config.API.TIMEOUTS.FACT_SIMPLE,
                'Fact table fetch timeout'
            );

            // Enrichissement en masse des dimensions pour toutes les lignes
            if (result && result.data) {
                const enrichedData = await withTimeout(
                    enrichFactsWithDimensions(result.data, loaders),
                    config.API.TIMEOUTS.FACT_COMPLEX,
                    'Dimension enrichment timeout'
                );
                
                return {
                    ...result,
                    data: enrichedData
                };
            }

            return result;
        },
        
        // Requête des faits avec métadonnées optimisées pour D3
        getFactTableWithMetadata: async (_, args, { loaders }) => {
            const result = await withTimeout(
                loaders.factWithMetadata.load(args),
                config.API.TIMEOUTS.FACT_SIMPLE,
                'Metadata fact table fetch timeout'
            );

            // Enrichissement en masse des dimensions pour toutes les lignes
            if (result && result.data) {
                const enrichedData = await withTimeout(
                    enrichFactsWithDimensions(result.data, loaders),
                    config.API.TIMEOUTS.FACT_COMPLEX,
                    'Dimension enrichment timeout'
                );
                
                return {
                    ...result,
                    data: enrichedData
                };
            }

            return result;
        }
    }
};

export { factResolvers };