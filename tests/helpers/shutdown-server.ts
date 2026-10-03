/**
 * Entry point of the child process of the shutdown integration test.
 *
 * Starts the real server (src/index.ts) on the test catalogs, with two hooks
 * the test drives over the IPC channel:
 * - `{ slowAcquireMs }` delays every pool acquisition from then on, which keeps
 *   an export in flight for a known time (the export route acquires its
 *   connection after taking its slot);
 * - `'SIGTERM'` emits the signal inside the process: Windows cannot deliver a
 *   real SIGTERM to a child, and the handler registered by startServer is the
 *   same one a real signal reaches.
 *
 * Environment: PORT, SHUTDOWN_TIMEOUT_MS.
 */

// Environnement de test (catalogues, Redis…), avant tout import de l'application
await import('../setup/setup-env.js');
process.env.LOG_TO_FILE = 'false';
// Clé admin connue : /metrics est testé avec et sans
process.env.ADMIN_API_KEY = 'shutdown-test-key';

const { DuckDBPool } = await import('../../src/db/pool.js');

let slowAcquireMs = 0;
const realAcquire = DuckDBPool.prototype.acquire;
DuckDBPool.prototype.acquire = async function (this: InstanceType<typeof DuckDBPool>, signal) {
  if (slowAcquireMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, slowAcquireMs));
  }
  return realAcquire.call(this, signal);
};

process.on('message', (message: unknown) => {
  if (message === 'SIGTERM') {
    process.emit('SIGTERM', 'SIGTERM');
  } else if (typeof message === 'object' && message !== null && 'slowAcquireMs' in message) {
    slowAcquireMs = Number((message as { slowAcquireMs: number }).slowAcquireMs);
  }
});

await import('../../src/index.js');
