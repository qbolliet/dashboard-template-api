// Unit tests for withTimeout (src/utils/timeout.js)
import { withTimeout } from '../../../src/utils/timeout.js';

describe('withTimeout', () => {
  test('resolves when promise completes within timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'Timeout');
    expect(result).toBe(42);
  });

  test('rejects with provided message when timeout exceeded', async () => {
    const slowPromise = new Promise(resolve => setTimeout(() => resolve('slow'), 200));
    await expect(withTimeout(slowPromise, 10, 'Query timed out')).rejects.toThrow('Query timed out');
  });

  test('rejects with an Error instance', async () => {
    const slowPromise = new Promise(resolve => setTimeout(() => resolve('slow'), 200));
    await expect(withTimeout(slowPromise, 10, 'Timed out')).rejects.toBeInstanceOf(Error);
  });

  test('propagates rejection from the original promise', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('original error')), 1000, 'timeout')
    ).rejects.toThrow('original error');
  });

  test('resolves with the correct value when the promise is faster', async () => {
    const value = { data: [1, 2, 3] };
    const result = await withTimeout(Promise.resolve(value), 500, 'too slow');
    expect(result).toBe(value);
  });
});
