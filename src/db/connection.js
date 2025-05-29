// Importation des modules
import { DuckDBPool } from './pool.js';
import path from 'path';
import fs from 'fs';
import yaml from 'yaml';

// Chargement du fichier de configuration
const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
// Chargement du fichier de configuration
// const config = yaml.load(fs.readFileSync('./config/config.yaml', 'utf8'));

// Construction du chemin vers la base de données
const dbPath = path.resolve(__dirname, '../../', config.DB_PATH);

// Vérification que le chemin vers la base de données existe
if (!fs.existsSync(dbPath)) {
  console.error(`WARNING: Database file not found at: ${dbPath}`);
} else {
  console.log(`Database file exists at: ${dbPath}, size: ${fs.statSync(dbPath).size} bytes`);
}

// Initialisation de la connection
const dbPool = new DuckDBPool({
  path: dbPath,
  maxConnections: config.DB_MAX_CONNECTIONS || 5,
  acquireTimeout: config.DB_ACQUIRE_TIMEOUT || 60
});
// Fonction de fermeture des connexions
const closeConnections = () => dbPool.close()

// Exportation du pool et de la fonction de clôture
export { dbPool, closeConnections };