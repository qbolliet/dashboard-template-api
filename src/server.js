// Importation des modules
const { ApolloServer } = require('apollo-server');
const { v4: uuidv4 } = require('uuid');
// Modules ad hoc
const { schema } = require('./schema');
const { createLoaders } = require('./loaders');
const { logger } = require('./utils/logger');
const { closeConnections } = require('./db');
const { redis } = require('./cache');

async function startServer() {
  const server = new ApolloServer({
    schema,
    context: async ({ req }) => ({
      requestId: uuidv4(),
      loaders: createLoaders(),
    }),
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

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await Promise.all([
      redis.quit(),
      closeConnections()
    ]);
    process.exit(0);
  });

  const { url } = await server.listen({ port: process.env.PORT });
  logger.info(`🚀 Server ready at ${url}`);
}

exports.startServer = startServer;