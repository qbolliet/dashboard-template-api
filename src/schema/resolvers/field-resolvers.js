// Importation des modules
import { withTimeout } from '../../utils/timeout.js';

// Construction d'un resolver pour associer un label à une dimension
/**
 * Field resolvers for resolving dimension labels in fact data
 * These resolvers are called for each fact record to resolve dimension details
 */
const fieldResolvers = {
    Fact: {
        // Résout les détails des dimensions pour inclure un label dans la table des faits
        /**
         * Resolves dimension details including labels
         * This resolver is called only when dimensionDetails field is requested
         * @param {Object} parent - The fact record
         * @param {Object} args - Field arguments (none for this field)
         * @param {Object} context - GraphQL context with loaders
         * @returns {Promise<Array>} Array of dimension details
         */
        dimensionDetails: async (parent, args, { loaders }) => {
            // Si le parent n'a pas de dimensions, retourner un tableau vide
            if (!parent.dimensions || parent.dimensions.length === 0) {
                return [];
            }

            // Récupération des noms de champs depuis le parent
            // Supposons que parent contient _fieldNames ou qu'on peut les déduire
            const fieldNames = parent._fieldNames || parent.dimensions.map((_, index) => `dim_${index + 1}`);

            // Récupération des métadonnées pour identifier les dimensions catégorielles
            const metadataPromises = fieldNames.map(fieldName => loaders.metadata.load(fieldName));
            const metadataResults = await Promise.all(metadataPromises);

            // Pour chaque dimension, charger les détails si elle est catégorielle
            const detailPromises = parent.dimensions.map(async (value, index) => {
                const fieldName = fieldNames[index];
                const metadata = metadataResults[index];

                // Si la dimension est catégorielle, charger le label depuis la table de dimension
                if (metadata && metadata.is_categorical) {
                    return loaders.dimensionValue.load({
                        dimensionName: fieldName,
                        value: value
                    });
                } else {
                    // Si non catégorielle, retourner la valeur brute
                    return {
                        name: fieldName,
                        value: String(value),
                        label: String(value)
                    };
                }
            });

            // Attendre toutes les résolutions avec timeout
            return withTimeout(
                Promise.all(detailPromises),
                5000,
                'Dimension details resolution timeout'
            );
        }
    },

    AggregatedFact: {
        // Résout les détails des dimensions pour inclure un label dans la table des faits agrégés
        /**
         * Resolves the label for aggregated fact keys
         * This is useful when grouping by categorical dimensions
         * @param {Object} parent - The aggregated fact record
         * @param {Object} args - Field arguments
         * @param {Object} context - GraphQL context with loaders
         * @returns {Promise<String>} Label for the key
         */
        keyLabel: async (parent, args, { loaders }) => {
            // Cette fonction nécessite de connaître le champ de regroupement
            // qui devrait être passé dans le contexte ou stocké dans le parent
            if (!parent._groupByField) {
                return parent.key;
            }

            // Vérifier si le champ de regroupement est catégoriel
            const metadata = await loaders.metadata.load(parent._groupByField);
            
            if (metadata && metadata.is_categorical) {
                const dimensionData = await loaders.dimensionValue.load({
                    dimensionName: parent._groupByField,
                    value: parent.key
                });
                return dimensionData.label;
            }

            return parent.key;
        }
    }
};

// Fonction auxiliaire pour associer des labels aux variables sur lesquelles agréger
/**
 * Helper function to enrich aggregated facts with groupBy field information
 * Should be used in aggregated facts resolver
 * @param {Array} results - Raw aggregated results
 * @param {String} groupByField - Field used for grouping
 * @returns {Array} Enriched results
 */
const enrichAggregatedFacts = (results, groupByField) => {
    return results.map(result => ({
        ...result,
        _groupByField: groupByField
    }));
};

export { fieldResolvers, enrichAggregatedFacts };