// Importation des modules
import { createMetadataLoader } from './metadata.js';
import { createDimensionLoader, createDimensionValueLoader } from './dimension.js';
import { createFactLoader } from './fact.js';
import { createSelectOptionsLoader } from './select-options.js';
import { createAggregatedFactsLoader, createAggregatedFactsWithMetadataLoader } from './aggregated-facts.js';


// Fonction de création des différents loaders
/**
 * Creates and initializes all data loaders
 * @returns {Object} Object containing all initialized loaders
 */
const createLoaders = () => {
    // Initialisation de tous les loaders
    const metadataLoader = createMetadataLoader();
    const dimensionLoader = createDimensionLoader();
    const dimensionValueLoader = createDimensionValueLoader();
    const factLoader = createFactLoader();
    const aggregatedFactsLoader = createAggregatedFactsLoader();
    const aggregatedFactsWithMetadataLoader = createAggregatedFactsWithMetadataLoader();
    const selectOptionsLoader = createSelectOptionsLoader();

    // Retourne un objet avec l'ensemble des loaders
    return {
        metadata: metadataLoader,
        dimension: dimensionLoader,
        dimensionValue: dimensionValueLoader,
        fact: factLoader,
        aggregatedFacts: aggregatedFactsLoader,
        aggregatedFactsWithMetadata: aggregatedFactsWithMetadataLoader,
        selectOptions: selectOptionsLoader,

        // Méthode pour nettoyer le cache de l'ensemble des loaders
        clearAll: () => {
            metadataLoader.clearAll();
            dimensionLoader.clearAll();
            dimensionValueLoader.clearAll();
            factLoader.clearAll();
            aggregatedFactsLoader.clearAll();
            aggregatedFactsWithMetadataLoader.clearAll();
            selectOptionsLoader.clearAll();
        },

        // Méthode d'amorçage de tous les loaders avec leurs données initiales
        prime: async (initialData = {}) => {
            const {
                metadata = [],
                dimensions = [],
                dimensionValues = [],
                facts = [],
                aggregatedFacts = [],
                aggregatedFactsWithMetadata = [],
                selectOptions = []
            } = initialData;

            // Amorçage de chaque loader avec ses données initiales
            metadata.forEach(({ key, value }) => {
                metadataLoader.prime(key, value);
            });

            dimensions.forEach(({ key, value }) => {
                dimensionLoader.prime(key, value);
            });

            dimensionValues.forEach(({ key, value }) => {
                dimensionValueLoader.prime(key, value);
            });

            facts.forEach(({ key, value }) => {
                factLoader.prime(key, value);
            });

            aggregatedFacts.forEach(({ key, value }) => {
                aggregatedFactsLoader.prime(key, value);
            });
            
            aggregatedFactsWithMetadata.forEach(({ key, value }) => {
                aggregatedFactsWithMetadataLoader.prime(key, value);
            });
            

            selectOptions.forEach(({ key, value }) => {
                selectOptionsLoader.prime(key, value);
            });
        }
    };
};

// Fonction pour créer de nouveaux loaders pour chaque demande
const createLoadersForRequest = () => {
    return createLoaders();
};

export { createLoaders, createLoadersForRequest };