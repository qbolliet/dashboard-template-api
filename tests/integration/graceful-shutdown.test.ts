/**
 * Integration tests of the graceful shutdown, on a real server process.
 *
 * The server (src/index.ts through tests/helpers/shutdown-server.ts) runs as a
 * child process on the test catalogs (npm run test:setup; Redis reachable),
 * with the shutdown signal sent over the IPC channel. Covers the acceptance
 * criteria: an export started before SIGTERM completes, a request after it is
 * refused, the process leaves before SHUTDOWN_TIMEOUT_MS, /ready is minimal
 * and /metrics answers 401 without the key.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// Démarrage à froid de DuckDB et de Redis compris
const START_TIMEOUT_MS = 60_000;

/** A child server and what is known of its exit. */
interface ServerHandle {
  port: number;
  child: ChildProcess;
  exited: Promise<{ code: number | null; at: number }>;
}

/** Response of a raw HTTP call. */
interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Finds a free TCP port.
 *
 * @returns A port nobody listens on.
 */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/**
 * Issues an HTTP GET on a fresh connection.
 *
 * @param port - Server port.
 * @param urlPath - Path and query string.
 * @param headers - Request headers.
 * @returns The status, headers and body.
 */
const get = (
  port: number,
  urlPath: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });

/**
 * Starts the server in a child process and waits for /health.
 *
 * @param shutdownTimeoutMs - SHUTDOWN_TIMEOUT_MS of the server.
 * @returns The handle of the running server.
 */
const startServer = async (shutdownTimeoutMs: number): Promise<ServerHandle> => {
  const port = await freePort();
  const child = fork(path.resolve('tests/helpers/shutdown-server.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      PORT: String(port),
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
      // Aucun fichier de log, aucune option Node héritée de la suite Jest
      LOG_TO_FILE: 'false',
      NODE_OPTIONS: '',
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
    child.once('exit', (code) => resolve({ code, at: Date.now() }));
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode})`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('Server did not answer /health in time');
    }
    try {
      if ((await get(port, '/health')).status === 200) break;
    } catch {
      // Pas encore à l'écoute
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { port, child, exited };
};

// Export csv de la table geography, ouvert avant le signal
const EXPORT_PATH =
  '/api/export?catalog=default&schema=geography&fields=commune,date,population,budget&format=csv';

describe('Graceful shutdown (child process)', () => {
  let server: ServerHandle | null = null;

  afterEach(async () => {
    if (server && server.child.exitCode === null) {
      server.child.kill('SIGKILL');
      await server.exited;
    }
    server = null;
  });

  test(
    'exposes a minimal /ready and protects /metrics',
    async () => {
      server = await startServer(5000);

      const ready = await get(server.port, '/ready');
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body)).toEqual({ status: 'ready' });

      const anonymous = await get(server.port, '/metrics');
      expect(anonymous.status).toBe(401);

      const keyed = await get(server.port, '/metrics', { 'x-admin-key': 'shutdown-test-key' });
      expect(keyed.status).toBe(200);
      expect(JSON.parse(keyed.body).requests).toBeDefined();
    },
    START_TIMEOUT_MS + 10_000,
  );

  test(
    'completes an export started before SIGTERM, refuses the next request, exits 0',
    async () => {
      server = await startServer(10_000);
      const { port, child, exited } = server;

      // L'export tient son créneau 2 s : il est en vol quand le signal arrive
      child.send({ slowAcquireMs: 2000 });
      const exportCall = get(port, EXPORT_PATH);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const signalAt = Date.now();
      child.send('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Après le signal : plus de connexion acceptée (ou 503), jamais une réponse utile
      const late = await get(port, '/graphql?query=%7B__typename%7D').then(
        (res) => res.status,
        (error: NodeJS.ErrnoException) => error.code,
      );
      expect([503, 'ECONNREFUSED', 'ECONNRESET']).toContain(late);

      // L'export en vol va à son terme, fichier complet
      const exported = await exportCall;
      expect(exported.status).toBe(200);
      const lines = exported.body.trim().split('\n');
      expect(lines[0]).toBe('commune,date,population,budget');
      expect(lines).toHaveLength(Number(exported.headers['x-row-count']) + 1);

      const { code, at } = await exited;
      expect(code).toBe(0);
      expect(at - signalAt).toBeLessThan(10_000);
    },
    START_TIMEOUT_MS + 30_000,
  );

  test(
    'exits before SHUTDOWN_TIMEOUT_MS when an export outlasts the budget',
    async () => {
      const budgetMs = 3000;
      server = await startServer(budgetMs);
      const { port, child, exited } = server;

      // Export bloqué 20 s : bien au-delà du budget
      child.send({ slowAcquireMs: 20_000 });
      const stuck = get(port, EXPORT_PATH).then(
        (res) => res.status,
        (error: NodeJS.ErrnoException) => error.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      const signalAt = Date.now();
      child.send('SIGTERM');

      const { at } = await exited;
      expect(at - signalAt).toBeLessThan(budgetMs);
      // Le client voit sa connexion coupée, pas une réponse
      expect(await stuck).not.toBe(200);
    },
    START_TIMEOUT_MS + 30_000,
  );
});
