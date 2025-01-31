// Importation des modules
const { DuckDBPool } = require('./pool');
const path = require('path');
const fs = require('fs');
const yaml = require('yaml');

// Chargement du fichier de configuration
const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
// Chargement du fichier de configuration
// const config = yaml.load(fs.readFileSync('./config/config.yaml', 'utf8'));

// Initialisation de la connection
const dbPool = new DuckDBPool({
  path: config.DB_PATH,
  maxConnections: config.DB_MAX_CONNECTIONS || 5,
  acquireTimeout: config.DB_ACQUIRE_TIMEOUT || 60
});

exports.dbPool = dbPool;
exports.closeConnections = () => dbPool.close();