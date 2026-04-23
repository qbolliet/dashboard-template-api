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
        getFactTable: async (_, args, { loaders, getLoadersForDatabase }) => {
            // Get appropriate loaders for the database
            const targetLoaders = getLoadersForDatabase(args.database);
            const factLoader = targetLoaders ? targetLoaders.factWithCount : loaders.factWithCount;
            const enrichmentLoaders = targetLoaders || loaders;
            
            const result = await withTimeout(
                factLoader.load(args),
                config.API.TIMEOUTS.FACT_SIMPLE,
                'Fact table fetch timeout'
            );

            // Enrichissement en masse des dimensions pour toutes les lignes
            if (result && result.data) {
                const enrichedData = await withTimeout(
                    enrichFactsWithDimensions(result.data, enrichmentLoaders),
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
        getFactTableWithMetadata: async (_, args, { loaders, getLoadersForDatabase }) => {
            const targetLoaders = getLoadersForDatabase(args.database);
            const activeLoaders = targetLoaders || loaders;

            const result = await withTimeout(
                activeLoaders.factWithMetadata.load(args),
                config.API.TIMEOUTS.FACT_SIMPLE,
                'Metadata fact table fetch timeout'
            );

            // Enrichissement en masse des dimensions pour toutes les lignes
            if (result && result.data) {
                const enrichedData = await withTimeout(
                    enrichFactsWithDimensions(result.data, activeLoaders),
                    config.API.TIMEOUTS.FACT_COMPLEX,
                    'Dimension enrichment timeout'
                );

                // Format ARRAYS : transformer [{col: val}] en [[val1, val2, ...]]
                // Les colonnes sont déjà présentes dans result.columns
                if (args.format === 'ARRAYS' && result.columns) {
                    return {
                        ...result,
                        data: enrichedData.map(row => result.columns.map(col => row[col] ?? null))
                    };
                }

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