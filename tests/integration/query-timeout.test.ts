/**
 * Integration test of the loader deadline on a real DuckDB pool.
 *
 * A loader whose query outlives its `queryTimeout` must not keep running in
 * the background: the query is interrupted (`connection.interrupt()`), the
 * load rejects with the timeout error, and the connection is back in the pool
 * — still usable — well under a second after the deadline.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { ensureSetup } from '../unit/test_schema/test_resolvers/helpers.js';
import { databaseManager } from '../../src/db/index.js';
import { BaseQueryLoader } from '../../src/loaders/base-loader.js';

// Requête volontairement lente (plusieurs secondes sans interruption)
const SLOW_QUERY = 'SELECT COUNT(*) AS n FROM range(3000000000) t(i) WHERE i % 7 = 3';

// Échéance courte du loader de test
const QUERY_TIMEOUT = 200;

beforeAll(async () => {
  await ensureSetup();
});

describe('loader queryTimeout on a real pool', () => {
  test('interrupts a slow query and releases its connection within 1 s', async () => {
    const pool = databaseManager.getPool('default');
    const loader = new BaseQueryLoader({
      cachePrefix: 'slow-test',
      cache: false,
      catalogId: 'default',
      queryTimeout: QUERY_TIMEOUT,
    });
    const dataLoader = loader.createLoader<string, unknown>((connection) =>
      connection.all(SLOW_QUERY),
    );

    const started = Date.now();
    await expect(dataLoader.load('slow')).rejects.toThrow(
      `slow-test query timeout after ${QUERY_TIMEOUT}ms`,
    );
    const elapsed = Date.now() - started;

    // Connexion rendue moins d'une seconde après l'échéance
    expect(elapsed).toBeLessThan(QUERY_TIMEOUT + 1000);
    expect(pool.getStats().using).toBe(0);

    // La connexion interrompue sert de nouveau, sans attente
    const acquiredAt = Date.now();
    const connection = await pool.acquire();
    try {
      expect(Date.now() - acquiredAt).toBeLessThan(100);
      const rows = await connection.all('SELECT 42 AS answer');
      expect(rows).toEqual([{ answer: 42 }]);
    } finally {
      pool.release(connection);
    }
  });

  test('a query finishing before the deadline is not affected', async () => {
    const loader = new BaseQueryLoader({
      cachePrefix: 'fast-test',
      cache: false,
      catalogId: 'default',
      queryTimeout: 5000,
    });
    const dataLoader = loader.createLoader<string, unknown>((connection) =>
      connection.all('SELECT COUNT(*) AS n FROM range(1000) t(i)'),
    );

    await expect(dataLoader.load('fast')).resolves.toEqual([{ n: 1000 }]);
  });
});
