// Arrêt gracieux du serveur : refus des nouvelles requêtes, drainage, puis fermeture des ressources
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from './utils/config-loader.js';
import { logger } from './utils/logger.js';

// Budget d'arrêt par défaut (ms), sous le terminationGracePeriodSeconds du chart (30 s)
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

// Part du budget laissée au drainage : le reste ferme le pool, le cache et les limiteurs
const DRAIN_BUDGET_RATIO = 0.8;

// Délai suggéré aux clients refusés (secondes) : un autre réplica prend le relais
const RETRY_AFTER_SECONDS = 1;

// Sondes de l'orchestrateur, servies jusqu'à la fin : /ready y répond 503 lui-même
const PROBE_PATHS = new Set(['/health', '/ready']);

/** A resource released at the end of the shutdown, after the drain. */
interface ShutdownStep {
  /** Name logged with a failure. */
  name: string;
  /** Releases the resource. */
  close: () => Promise<unknown> | unknown;
}

/** Dependencies of the shutdown sequence. */
interface ShutdownOptions {
  /**
   * Stops accepting connections and waits for the in-flight requests and
   * exports (Apollo's `server.stop()` with ApolloServerPluginDrainHttpServer,
   * whose grace period is {@link drainBudgetMs}).
   */
  drain: () => Promise<void>;
  /** Synchronous actions run first (background timers to stop). */
  beforeDrain?: Array<() => void>;
  /** Resources released in order once the drain is over: pool, limiters, Redis. */
  steps: ShutdownStep[];
  /** Overall budget in milliseconds; defaults to API.SHUTDOWN.TIMEOUT_MS. */
  timeoutMs?: number;
  /** Process exit, injectable for tests. */
  exit?: (code: number) => void;
}

/** Handle of a shutdown sequence. */
interface Shutdown {
  /** True from the first signal on. */
  isShuttingDown: () => boolean;
  /** Runs the sequence (once: a later call returns the same promise). */
  run: (signal: string) => Promise<void>;
  /** Express middleware refusing every request but the probes once the shutdown began. */
  guard: RequestHandler;
}

/**
 * Reads the shutdown budget of the configuration.
 *
 * @returns API.SHUTDOWN.TIMEOUT_MS in milliseconds (default 25 s when absent or invalid).
 */
// Budget d'arrêt configuré, tolérant la forme des variables d'environnement
const configuredShutdownTimeoutMs = (): number => {
  const value = Number(config.API.SHUTDOWN?.TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SHUTDOWN_TIMEOUT_MS;
};

/**
 * Computes the part of the shutdown budget given to the drain.
 *
 * @param timeoutMs - Overall budget; defaults to API.SHUTDOWN.TIMEOUT_MS.
 * @returns The grace period, in milliseconds, after which connections still
 *   open are cut.
 */
// Part du budget accordée au drainage (grace period du plugin Apollo)
const drainBudgetMs = (timeoutMs: number = configuredShutdownTimeoutMs()): number =>
  Math.floor(timeoutMs * DRAIN_BUDGET_RATIO);

/**
 * Builds the graceful shutdown of the server.
 *
 * Sequence on the first signal:
 * 1. new requests are refused with a 503 (`Connection: close`, `Retry-After`)
 *    and `/ready` fails, so the orchestrator stops routing to this instance;
 * 2. `drain`: the listening socket closes and in-flight requests, exports
 *    included, run to completion, within 80 % of the budget; past it their
 *    connections are cut (an export then ends truncated, as on any abort);
 * 3. the steps run in order — pool, limiters, Redis: nothing holds a
 *    connection any more when they are closed;
 * 4. the process exits with 0, or 1 when a step failed.
 *
 * A watchdog on the overall budget exits with 1 whatever blocks, so that the
 * process always leaves before the orchestrator's SIGKILL. A second signal
 * during the sequence is ignored.
 *
 * @param options - Dependencies of the sequence.
 * @returns The shutdown handle.
 */
const createShutdown = (options: ShutdownOptions): Shutdown => {
  const timeoutMs = options.timeoutMs ?? configuredShutdownTimeoutMs();
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  let running: Promise<void> | null = null;

  const sequence = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal} signal. Starting graceful shutdown...`, { timeoutMs });
    let failed = false;

    // Garde-fou : le processus sort avant le SIGKILL de l'orchestrateur. Non
    // « unref » à dessein : une fois le serveur HTTP fermé, ce minuteur est ce
    // qui garde le processus en vie jusqu'à la fin de la séquence (sans lui, la
    // boucle d'événements se vide et le processus sort avant la fermeture du pool)
    const watchdog = setTimeout(() => {
      logger.error(`Graceful shutdown exceeded ${timeoutMs} ms, forcing exit`);
      exit(1);
    }, timeoutMs);

    try {
      options.beforeDrain?.forEach((action) => action());
    } catch (error) {
      failed = true;
      logger.error('Error before draining:', error);
    }

    try {
      await options.drain();
      logger.info('HTTP server drained');
    } catch (error) {
      failed = true;
      logger.error('Error while draining the HTTP server:', error);
    }

    // Une étape en échec n'empêche pas les suivantes
    for (const step of options.steps) {
      try {
        await step.close();
      } catch (error) {
        failed = true;
        logger.error(`Error closing ${step.name}:`, error);
      }
    }

    clearTimeout(watchdog);
    logger.info(failed ? 'Graceful shutdown completed with errors' : 'Graceful shutdown completed');
    exit(failed ? 1 : 0);
  };

  return {
    isShuttingDown: () => running !== null,
    run: (signal) => {
      running ??= sequence(signal);
      return running;
    },
    guard: (req: Request, res: Response, next: NextFunction): void => {
      if (running === null || PROBE_PATHS.has(req.path)) {
        next();
        return;
      }
      // Fermeture de la connexion persistante : le client rouvre vers un autre réplica
      res.set({ Connection: 'close', 'Retry-After': String(RETRY_AFTER_SECONDS) });
      res.status(503).json({ error: 'Server is shutting down', detail: 'Retry shortly.' });
    },
  };
};

export { createShutdown, drainBudgetMs, configuredShutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS };
export type { Shutdown, ShutdownOptions, ShutdownStep };
