// Importation des modules
const { ApolloServer } = require('apollo-server');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const yaml = require('js-yaml');
// Modules ad hoc
import { typeDefs } from './schema';
import { resolvers } from './resolvers';

// Chargement du fichier de configuration
const config = yaml.load(fs.readFileSync('./../config/config.yaml', 'utf8'));


// Apollo Server
const server = new ApolloServer({
  typeDefs,
  resolvers,
  introspection: true,
  playground: true,
  formatError: (err) => {
    const errorId = uuidv4();
    logger.error(`Error [${errorId}]: ${err.message}`, {
      stack: err.stack,
    });
    return {
      message: err.message,
      code: err.extensions?.code || 'INTERNAL_SERVER_ERROR',
      errorId,
    };
  },
  context: ({ req }) => {
    const requestId = uuidv4();
    logger.info(`Request [${requestId}]: ${req.body?.query}`, {
      variables: req.body?.variables,
    });
    return { requestId };
  },
});

// Start server
server.listen({ port: config.PORT }).then(({ url }) => {
  logger.info(`🚀 Server ready at ${url}`);
});
