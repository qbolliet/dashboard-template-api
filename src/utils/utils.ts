// Importation des modules
import { GraphQLError } from 'graphql';

/**
 * Validates a SQL identifier against safe naming rules.
 *
 * Rejects anything that starts with a digit or contains characters outside
 * the set [a-zA-Z0-9_] to prevent SQL injection via identifier names. The
 * error is a GraphQLError (BAD_USER_INPUT) so that it reaches the client
 * instead of being swallowed by the loaders' generic error handling.
 *
 * @param name - The candidate identifier to validate.
 * @param context - Label used in the error message to describe the identifier type.
 * @returns The validated identifier, unchanged.
 * @throws {GraphQLError} When the identifier contains unsafe characters or is not a string.
 */
// Validation d'un identifiant SQL — protection contre les injections par nom de champ
const validateIdentifier = (name: unknown, context: string = 'field'): string => {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new GraphQLError(
      `Invalid ${context} name: "${String(name)}". Only alphanumeric characters and underscores are allowed.`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
  return name;
};

export { validateIdentifier };
