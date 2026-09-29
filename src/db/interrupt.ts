// Importation des types DuckDB
import type { DuckDBConnection } from '@duckdb/node-api';

/**
 * Runs a DuckDB step so that an abort of the signal interrupts it.
 *
 * The interrupt is only issued while the step is running: interrupting an
 * idle connection is never needed, and the connection goes back to the pool
 * right after. An interrupted query fails with « Interrupted! »; the error
 * reported is then the abort reason, which is the real cause.
 *
 * @param connection - Pool connection running the step.
 * @param signal - Cancellation signal (timeout, client abort).
 * @param step - DuckDB work to run.
 * @returns The step result.
 * @throws The abort reason when the signal fired before or during the step.
 */
// Interruption de la requête DuckDB en cours si le signal se déclenche
export const runInterruptible = async <T>(
  connection: { conn: Pick<DuckDBConnection, 'interrupt'> },
  signal: AbortSignal,
  step: () => Promise<T>,
): Promise<T> => {
  signal.throwIfAborted();
  const onAbort = (): void => connection.conn.interrupt();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await step();
  } catch (error) {
    // Une requête interrompue échoue avec « Interrupted! » : la vraie cause est le signal
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};
