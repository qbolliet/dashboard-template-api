// Importation des modules
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { typeDefs } = require('./typedefs');
const { resolvers } = require('./resolvers');

// Construction du schéma
const schema = makeExecutableSchema({
  typeDefs,
  resolvers
});

// Ré-exportation des éléments d'intérêt
module.exports = {
  schema
};