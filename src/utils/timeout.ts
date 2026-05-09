/**
 * Wraps a promise with a timeout, rejecting if the deadline is exceeded.
 *
 * @param promise - The promise to race against the timer.
 * @param ms - Timeout duration in milliseconds.
 * @param message - Error message used when the timeout fires.
 * @returns A promise that resolves with the original value or rejects on timeout.
 */
// Décorateur de promesse avec limite de durée
const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(message)), ms)
        )
    ]);
};

export { withTimeout };
