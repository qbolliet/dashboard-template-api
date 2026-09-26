// Importation des modules
import { GraphQLScalarType, Kind, valueFromASTUntyped } from 'graphql';
import { typeDefs } from './typedefs/index.js';

// Description du scalaire JSON
/**
 * Reads the description of the `JSON` scalar in the SDL.
 *
 * `makeExecutableSchema` replaces the SDL scalar by the implementation given in
 * the resolvers, description included: the text is read back from the type
 * definitions so that the SDL stays the single source of the contract.
 *
 * @returns The SDL description of the scalar, or undefined when it has none.
 */
function jsonScalarDescription(): string | undefined {
  for (const definition of typeDefs.definitions) {
    if (definition.kind === Kind.SCALAR_TYPE_DEFINITION && definition.name.value === 'JSON') {
      return definition.description?.value;
    }
  }
  return undefined;
}

// Scalaire JSON
/**
 * `JSON` scalar of the schema.
 *
 * The values are already normalised by the single JSON converter of the database
 * layer (safe integers as numbers, larger ones as strings, ISO dates…), so the
 * scalar passes them through unchanged. Literals written inline in a query
 * (`value: {min: 1, max: 9}`) and variables are read as plain JSON, the
 * variables of the operation being substituted.
 */
const JSONScalar = new GraphQLScalarType<unknown, unknown>({
  name: 'JSON',
  description: jsonScalarDescription(),
  serialize: (value: unknown): unknown => value,
  parseValue: (value: unknown): unknown => value,
  parseLiteral: (ast, variables): unknown => valueFromASTUntyped(ast, variables),
});

export { JSONScalar };
