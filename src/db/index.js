// Importation des éléments du dossier
const { dbPool, closeConnections } = require('./connection');
const { DuckDBPool } = require('./pool');

// Ré-exportation des fonctions d'intérêt
module.exports = {
  dbPool,
  closeConnections,
  DuckDBPool,
};
