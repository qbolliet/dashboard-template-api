// Importation des modules
const { DuckDBPool } = require('./pool');
const config = require('../config');
// Chargement du fichier de configuration
// const config = yaml.load(fs.readFileSync('./config/config.yaml', 'utf8'));

// Initialisation de la connection
const dbPool = new DuckDBPool({
  path: config.DB_PATH,
  maxConnections: config.DB_MAX_CONNECTIONS,
  acquireTimeout: config.DB_ACQUIRE_TIMEOUT
});

exports.dbPool = dbPool;
exports.closeConnections = () => dbPool.close();