// Importation des modules d'intérêt
import { metadataResolvers } from './metadata.js';
import { dimensionResolvers } from './dimension.js';
import { factResolvers } from './fact.js';
import { aggregatedFactsResolvers } from './aggregated-facts.js';
import { selectOptionsResolvers } from './select-options.js';
import { fieldResolvers } from './field-resolvers.js';
import { catalogResolvers } from './catalog.js';
import { crossDatabaseResolvers } from './cross-database.js';

// Combinaison des différents resolvers
const resolvers = {
    Query: {
        ...metadataResolvers.Query,
        ...dimensionResolvers.Query,
        ...factResolvers.Query,
        ...aggregatedFactsResolvers.Query,
        ...selectOptionsResolvers.Query,
        ...catalogResolvers.Query,
        ...crossDatabaseResolvers.Query
    },
    // Ajout des field resolvers pour la résolution des labels
    ...fieldResolvers
};

// Ré-exportation de la combinaison
export { resolvers };