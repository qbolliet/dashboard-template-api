// Importation des éléments du dossier
const { createRedisClient } = require('./redis');

// Initialisation d'un instance redis utilisée dans l'application
const redis = createRedisClient();

// Ré-exportation des fonctions d'intérêt
module.exports = {
    redis,
    createRedisClient
};
  