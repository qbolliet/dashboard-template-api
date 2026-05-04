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

// Ré-exportation des fonctions d'intérêt
export {
    dbPool,
    closeConnections,
    DuckDBPool,
    databaseManager,
    closeAllConnections,
    getDefaultPool,
    DatabaseManager
};
