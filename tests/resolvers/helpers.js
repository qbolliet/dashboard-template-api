import { ApolloServer } from '@apollo/server';
import { schema } from '../../src/schema/index.js';
import { createLoaders } from '../../src/loaders/index.js';
import { databaseManager } from '../../src/db/index.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _server = null;

// Verify that the test catalog has been set up by npm run test:setup.
// Tests cannot write to the catalog (READ_ONLY=true in setup-env.js) to allow
// multiple Jest VM contexts to open the same DuckLake file simultaneously.
export const ensureSetup = async () => {
  const catalogPath = path.resolve(__dirname, '../../data/test-default.ducklake');
  if (!fs.existsSync(catalogPath)) {
    throw new Error(
      `Test catalog not found: ${catalogPath}\n` +
      `Run "npm run test:setup" before running the resolver tests.`
    );
  }
};

export const getServer = async () => {
  if (!_server) {
    _server = new ApolloServer({ schema });
    await _server.start();
  }
  return _server;
};

// Wraps executeOperation to normalize Apollo Server v5 response format
// into the familiar { data, errors } shape.
// Mirrors the contextValue built in src/server.js.
export const execute = async (server, operation) => {
  const defaultDb = databaseManager.getDefaultDatabase();
  const { body } = await server.executeOperation(operation, {
    contextValue: {
      requestId: uuidv4(),
      loaders: createLoaders(defaultDb),
      databaseManager,
      requestDatabase: defaultDb,
      getLoadersForDatabase: (databaseId) => {
        const targetDb = databaseManager.validateDatabaseRouting(databaseId, defaultDb);
        return targetDb === defaultDb ? null : createLoaders(targetDb);
      }
    }
  });
  if (body.kind === 'single') return body.singleResult;
  return { data: null, errors: [{ message: 'Unexpected incremental response' }] };
};
