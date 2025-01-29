// Importation des modules
const typeDefs = require('./typedefs');
const { resolvers } = require('./resolvers');

// Construction du schéma
const schema = {
  typeDefs,
  resolvers
};

// Ré-exportation des éléments d'intérêt
module.exports = {
  schema
};