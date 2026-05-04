/**
 * Unit tests for the withTimeout utility (src/utils/timeout.ts).
 *
 * Verifies that withTimeout resolves, rejects on timeout, and propagates
 * rejections from the wrapped promise.
 */

// Importation directe — aucun mock requis pour ce module.
import { withTimeout } from '../../../src/utils/timeout.js';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  test('resolves when promise completes within timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'Timeout');
    expect(result).toBe(42);
  });

  test('rejects with provided message when timeout exceeded', async () => {
    // Promesse intentionnellement lente (200 ms) avec timeout de 10 ms.
    const slowPromise = new Promise<string>(resolve => setTimeout(() => resolve('slow'), 200));
    await expect(withTimeout(slowPromise, 10, 'Query timed out')).rejects.toThrow('Query timed out');
  });

  test('rejects with an Error instance', async () => {
    // Vérification du type d'erreur levée par le timeout.
    const slowPromise = new Promise<string>(resolve => setTimeout(() => resolve('slow'), 200));
    await expect(withTimeout(slowPromise, 10, 'Timed out')).rejects.toBeInstanceOf(Error);
  });

  test('propagates rejection from the original promise', async () => {
    // Propagation de l'erreur originale — le timeout ne doit pas masquer l'erreur.
    await expect(
      withTimeout(Promise.reject(new Error('original error')), 1000, 'timeout')
    ).rejects.toThrow('original error');
  });

  test('resolves with the correct value when the promise is faster', async () => {
    // Conservation de la valeur résolue — identité par référence.
    const value = { data: [1, 2, 3] };
    const result = await withTimeout(Promise.resolve(value), 500, 'too slow');
    expect(result).toBe(value);
  });
});
