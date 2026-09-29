/**
 * Wraps a promise with a timeout, rejecting if the deadline is exceeded.
 *
 * Only the caller stops waiting: the underlying work is not cancelled. DuckDB
 * queries are interrupted by the loaders' own deadline (see
 * `BaseQueryLoader.queryTimeout`), aligned on the same values.
 *
 * @param promise - The promise to race against the timer.
 * @param ms - Timeout duration in milliseconds.
 * @param message - Error message used when the timeout fires.
 * @returns A promise that resolves with the original value or rejects on timeout.
 */
// Décorateur de promesse avec limite de durée
const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  // Initialisation du timer
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Timout appliqué à une promesse
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

export { withTimeout };
