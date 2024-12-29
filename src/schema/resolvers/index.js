// Importation des modules d'intérêt
const { metadataResolvers } = require('./metadata');
const { dimensionResolvers } = require('./dimension');
const { factResolvers } = require('./fact');
const { aggregatedFactsResolvers } = require('./aggregated-facts');
const { selectOptionsResolvers } = require('./select-options');

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
module.exports = {
    resolvers
};