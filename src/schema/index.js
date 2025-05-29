// Importation des modules
import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs } from './typedefs/index.js';
import { resolvers } from './resolvers/index.js';

// Construction du schéma
const schema = makeExecutableSchema({
  typeDefs,
  resolvers
});

// Ré-exportation des éléments d'intérêt
export { schema };