// Importation des éléments du dossier
import { dbPool, closeConnections } from './connection.js';
import { DuckDBPool } from './pool.js';

// Ré-exportation des fonctions d'intérêt
export { dbPool, closeConnections, DuckDBPool };
