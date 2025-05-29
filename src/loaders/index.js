// Importation des modules
import { createMetadataLoader } from './metadata.js';
import { createDimensionLoader } from './dimension.js';
import { createFactLoader } from './fact.js';
import { createSelectOptionsLoader } from './select-options.js';
import { createAggregatedFactsLoader } from './aggregated-facts.js';

/**
 * Creates and initializes all data loaders
 * @returns {Object} Object containing all initialized loaders
 */
const createLoaders = () => {
    // Initialize all loaders
    const metadataLoader = createMetadataLoader();
    const dimensionLoader = createDimensionLoader();
    const factLoader = createFactLoader();
    const aggregatedFactsLoader = createAggregatedFactsLoader();
    const selectOptionsLoader = createSelectOptionsLoader();

    // Return an object with all loaders
    return {
        metadata: metadataLoader,
        dimension: dimensionLoader,
        fact: factLoader,
        aggregatedFacts: aggregatedFactsLoader,
        selectOptions: selectOptionsLoader,

        // Helper method to clear all loader caches
        clearAll: () => {
            metadataLoader.clearAll();
            dimensionLoader.clearAll();
            factLoader.clearAll();
            aggregatedFactsLoader.clearAll();
            selectOptionsLoader.clearAll();
        },

        // Helper method to prime all loaders with initial data
        prime: async (initialData = {}) => {
            const {
                metadata = [],
                dimensions = [],
                facts = [],
                aggregatedFacts = [],
                selectOptions = []
            } = initialData;

            // Prime each loader with its respective initial data
            metadata.forEach(({ key, value }) => {
                metadataLoader.prime(key, value);
            });

            dimensions.forEach(({ key, value }) => {
                dimensionLoader.prime(key, value);
            });

            facts.forEach(({ key, value }) => {
                factLoader.prime(key, value);
            });

            aggregatedFacts.forEach(({ key, value }) => {
                aggregatedFactsLoader.prime(key, value);
            });

            selectOptions.forEach(({ key, value }) => {
                selectOptionsLoader.prime(key, value);
            });
        }
    };
};

// Factory function to create new loaders for each request
const createLoadersForRequest = () => {
    return createLoaders();
};

export { createLoaders, createLoadersForRequest };