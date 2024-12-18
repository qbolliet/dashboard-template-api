// Importation des modules
const { ApolloServer } = require('apollo-server');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const yaml = require('js-yaml');
// Modules ad hoc
const { typeDefs } = require('./schema');
const { resolvers } = require('./resolvers');
const { logger } = require('./utils/logger');
const { SecurityManager } = require('./security');

// Chargement du fichier de configuration
const config = yaml.load(fs.readFileSync('./config/config.yaml', 'utf8'));

// Ligne 20: Add custom directives for field-level validation

// Apollo Server
const server = new ApolloServer({
  typeDefs,
  resolvers,
  schemaDirectives: {
    validate: ValidationDirective
},
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
    //ip: req.ip,
    const requestId = uuidv4();
    logger.info(`Request [${requestId}]: ${req.body?.query}`, {
      variables: req.body?.variables,
    });
    return { requestId };
  },
  plugins: [
    {
        // Plugin de fréquence limite de requête de l'API
        requestDidStart() {
            return {
                executionDidStart(context) {
                    return SecurityManager.createRateLimiter()(context, () => true);
                }
            };
        }
    }
  ],
  // Application de la gestion de la performance à l'ensemble des resolvers
  fieldResolver: SecurityManager.createPerformanceMonitor()
});

// Start server
server.listen({ port: config.PORT }).then(({ url }) => {
  logger.info(`🚀 Server ready at ${url}`);
});
