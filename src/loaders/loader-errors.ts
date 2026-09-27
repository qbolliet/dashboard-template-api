// Importation des modules
import { GraphQLError } from 'graphql';

// Erreurs DuckDB imputables à l'entrée du client : colonne ou fonction
// introuvable, LIMIT/OFFSET négatif, conversion impossible, expression
// régulière refusée par RE2. Les autres erreurs de binder (catalogue ou table
// absent) relèvent du serveur et ne sont pas concernées.
const USER_INPUT_PATTERNS = [
  /^Conversion Error:/,
  /^Invalid Input Error:/,
  /^Binder Error: (Referenced column|No function matches|LIMIT\/OFFSET)/,
];

/**
 * Classifies an error raised while loading one DataLoader key.
 *
 * Loaders never turn an error into null: the error becomes the value of the
 * failing key, so DataLoader rejects that key only.
 * - A GraphQLError (explicit validation) is returned unchanged.
 * - A DuckDB binder, conversion or input error caused by the request (unknown
 *   column, aggregation on an incompatible type, regex rejected by RE2…)
 *   becomes a BAD_USER_INPUT GraphQLError carrying the first line of the
 *   DuckDB message.
 * - Anything else (I/O, S3, missing catalog…) is returned as is: the server's
 *   formatError reports it as INTERNAL_SERVER_ERROR with an errorId.
 *
 * @param error - Error thrown by the load function.
 * @returns The error to attach to the key.
 */
// Classification d'une erreur de chargement : entrée client ou erreur serveur
function toLoaderError(error: unknown): Error {
  if (error instanceof GraphQLError) return error;
  // Test structurel plutôt qu'instanceof : une erreur du binding natif peut
  // venir d'un autre realm (contextes VM de Jest) sans cesser d'être une Error
  if (!isErrorLike(error)) return new Error(String(error));

  if (USER_INPUT_PATTERNS.some((pattern) => pattern.test(error.message))) {
    const [firstLine] = error.message.split('\n');
    return new GraphQLError(firstLine, {
      extensions: { code: 'BAD_USER_INPUT' },
      originalError: error,
    });
  }
  return error;
}

/**
 * Tells whether a thrown value is an Error, whatever realm created it.
 *
 * @param value - Thrown value.
 * @returns True when the value carries a string `message` and a `name`.
 */
// Reconnaissance structurelle d'une Error
function isErrorLike(value: unknown): value is Error {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Error).message === 'string' &&
    typeof (value as Error).name === 'string'
  );
}

export { toLoaderError };
