// Importation des modules
import { databaseManager, closeAllConnections } from './database-manager.js';
import { createContextLogger } from '../utils/logger.js';

// Création du logger contextualisé pour ce module
const dbLogger = createContextLogger({
  component: 'database',
  module: 'connection',
});

/**
 * Returns the shared DuckDB connection pool for the default catalog.
 * Provided for backward compatibility with code that does not pass a catalog ID.
 *
 * @returns The shared `DuckDBPool` instance.
 */
const getDefaultPool = () => {
  return databaseManager.getPool();
};

/**
 * Default connection pool for the default catalog.
 * Alias of {@link getDefaultPool} retained for backward compatibility.
 */
const dbPool = getDefaultPool();

/**
 * Closes all open database connections.
 * Thin wrapper around {@link closeAllConnections} retained for backward compatibility.
 */
const closeConnections = async (): Promise<void> => {
  dbLogger.database('Closing all database connections (legacy function)');
  await closeAllConnections();
};

// Exportation pour compatibilité et nouvelles fonctionnalités
export { dbPool, closeConnections, databaseManager, closeAllConnections, getDefaultPool };
