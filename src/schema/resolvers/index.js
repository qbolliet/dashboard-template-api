// Importation des modules d'intérêt
import { metadataResolvers } from './metadata.js';
import { dimensionResolvers } from './dimension.js';
import { factResolvers } from './fact.js';
import { aggregatedFactsResolvers } from './aggregated-facts.js';
import { selectOptionsResolvers } from './select-options.js';

// Combinaison des différents resolvers
const resolvers = {
    Query: {
        ...metadataResolvers.Query,
        ...dimensionResolvers.Query,
        ...factResolvers.Query,
        ...aggregatedFactsResolvers.Query,
        ...selectOptionsResolvers.Query
    }
};

// Ré-exportation de la combinaison
export { resolvers };