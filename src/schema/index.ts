// Importation des modules
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLSchema } from 'graphql';
import { typeDefs } from './typedefs/index.js';
import { resolvers } from './resolvers/index.js';

/**
 * Executable GraphQL schema for the dashboard API.
 *
 * Combines the merged type definitions and resolvers into a single
 * GraphQLSchema instance passed to Apollo Server.
 *
 * @returns A fully constructed GraphQLSchema ready for execution.
 */
// Construction du schéma exécutable à partir des typedefs et resolvers
const schema: GraphQLSchema = makeExecutableSchema({
  typeDefs,
  resolvers,
});

// Ré-exportation du schéma
export { schema };
