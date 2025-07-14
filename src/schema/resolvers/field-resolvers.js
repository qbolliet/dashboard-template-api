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
         * Now returns pre-loaded dimension details from bulk enrichment
         * @param {Object} parent - The fact record (already enriched)
         * @param {Object} args - Field arguments (none for this field)
         * @param {Object} context - GraphQL context with loaders
         * @returns {Array} Array of dimension details (pre-loaded)
         */
        dimensionDetails: async (parent, args, { loaders }) => {
            // Si le parent a déjà des dimensionDetails pré-chargés, les retourner
            if (parent && parent.dimensionDetails) {
                return parent.dimensionDetails;
            }

            // Fallback pour les cas où l'enrichissement n'a pas eu lieu
            // (ne devrait normalement pas arriver avec la nouvelle implémentation)
            if (!parent || typeof parent !== 'object') {
                return [];
            }

            // Extraction de tous les champs qui pourraient être des dimensions
            const excludedFields = ['value', '_groupByField', 'dimensionDetails'];
            const dimensionFields = Object.keys(parent).filter(
                key => !excludedFields.includes(key) && parent[key] !== null
            );

            if (dimensionFields.length === 0) {
                return [];
            }

            // Fallback: génération des détails sans chargement de base de données
            // Pour éviter les requêtes N+1 en cas de problème avec l'enrichissement
            return dimensionFields.map(fieldName => ({
                name: fieldName,
                value: parent[fieldName],
                label: parent[fieldName] // Utilise la valeur brute comme label
            }));
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