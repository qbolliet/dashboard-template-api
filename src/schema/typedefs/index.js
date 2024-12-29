// Importation des éléments du dossier
const { gql, mergeTypeDefs } = require('apollo-server');
const commonTypeDefs = require('./common');
const { dimensionTypeDefs } = require('./dimension');
const { factTypeDefs } = require('./fact');
const { metadataTypeDefs } = require('./metadata');
const selectTypeDefs = require('./select');

// Initialisation de la requête
const baseTypeDefs = gql`
  type Query {
    _empty: String
  }
`;

// Combinaison de toutes les définitions
const typeDefs = mergeTypeDefs([
  baseTypeDefs,
  commonTypeDefs,
  dimensionTypeDefs,
  factTypeDefs,
  metadataTypeDefs,
  selectTypeDefs
]);

// Réexportation des éléments d'intérêt
module.exports = typeDefs;