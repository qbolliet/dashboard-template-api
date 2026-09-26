/**
 * Runs a command while the API is up on the Jest test catalogs.
 *
 * Used to generate the data dictionary (and to build the documentation in CI) without a
 * deployed API: `npm run docs:dictionary:test`, `npm run docs:build:test-api`. The
 * environment is the one of the test suite (tests/setup/setup-env.ts, single source), so
 * `npm run test:setup` must have created the catalogs, and Redis must be reachable.
 *
 * The command inherits the caller's own environment plus `API_URL` (GraphQL endpoint of
 * the started API). The server is stopped when the command ends; the exit code is the
 * one of the command.
 *
 * Usage:
 *   tsx scripts/with-test-api.ts [--port <n>] -- <command…>
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const DEFAULT_PORT = 4010;
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_INTERVAL_MS = 500;

// Environnement de l'appelant, avant que le setup de test ne le surcharge
const callerEnv: NodeJS.ProcessEnv = { ...process.env };

/**
 * Parses the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns The API port and the command to run.
 * @throws {Error} When no command follows `--`.
 */
function parseArgs(argv: string[]): { port: number; command: string } {
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? '' : argv.slice(separator + 1).join(' ');
  if (!command) {
    throw new Error('Usage: tsx scripts/with-test-api.ts [--port <n>] -- <command…>');
  }
  const portIndex = options.indexOf('--port');
  const port = portIndex === -1 ? DEFAULT_PORT : Number(options[portIndex + 1]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port value: ${options[portIndex + 1]}`);
  }
  return { port, command };
}

/**
 * Waits until the API answers on `/health`.
 *
 * @param port - Port of the started API.
 * @param server - Server process, watched to fail fast when it exits.
 * @throws {Error} When the server exits or does not answer within the timeout.
 */
async function waitForHealth(port: number, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`The test API exited with code ${server.exitCode} before being ready.`);
    }
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) return;
    } catch {
      // Serveur pas encore à l'écoute
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
  }
  throw new Error(`The test API did not answer on /health within ${HEALTH_TIMEOUT_MS / 1000} s.`);
}

/**
 * Stops the server and waits for its exit.
 *
 * @param server - Server process started by this script.
 */
async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  server.kill();
  await exited;
}

async function main(): Promise<number> {
  const { port, command } = parseArgs(process.argv.slice(2));

  // Variables de test (catalogues, Redis…) appliquées à ce processus, donc au serveur enfant
  await import('../tests/setup/setup-env.js');
  process.env.PORT = String(port);
  process.env.LOG_TO_FILE = 'false';

  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    await waitForHealth(port, server);
    process.stdout.write(`[with-test-api] test API ready on port ${port}\n`);

    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: { ...callerEnv, API_URL: `http://localhost:${port}/graphql` },
    });
    return await new Promise<number>((resolve) => {
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    await stopServer(server);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `[with-test-api] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
