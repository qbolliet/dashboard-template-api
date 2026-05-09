// Importation des éléments du dossier
import {
    dbPool,
    closeConnections,
    databaseManager,
    closeAllConnections,
    getDefaultPool
} from './connection.js';
import { DuckDBPool } from './pool.js';
import { DatabaseManager } from './database-manager.js';

/**
 * Public database module API.
 *
 * Re-exports the shared pool instance, the database manager singleton,
 * connection helpers, and the underlying pool and manager classes.
 */
export {
    dbPool,
    closeConnections,
    DuckDBPool,
    databaseManager,
    closeAllConnections,
    getDefaultPool,
    DatabaseManager
};
