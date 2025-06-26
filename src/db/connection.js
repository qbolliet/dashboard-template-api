// Importation des modules
import { DuckDBPool } from './pool.js';
import { dirname, resolve } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// Emplacement du fichier et du dossier
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Création du logger contextualisé pour ce module
const dbLogger = createContextLogger({ 
    component: 'database',
    module: 'connection'
});

// Construction du chemin vers la base de données
const dbPath = resolve(__dirname, '../../', config.DATABASE.PATH);

// Vérification que le chemin vers la base de données existe
if (!fs.existsSync(dbPath)) {
    dbLogger.error('Database file not found', new Error('File not found'), {
        path: dbPath,
        configPath: config.DATABASE.PATH
    });
    // On continue quand même car DuckDB peut créer le fichier
} else {
    const stats = fs.statSync(dbPath);
    dbLogger.database('Database file found', {
        path: dbPath,
        size: stats.size,
        modified: stats.mtime
    });
}

// Initialisation de la connection pool avec les paramètres de configuration
const poolConfig = {
    path: dbPath,
    maxConnections: config.DATABASE.POOL.MAX_CONNECTIONS,
    acquireTimeout: config.DATABASE.POOL.ACQUIRE_TIMEOUT,
    retryDelay: config.DATABASE.POOL.CONNECTION_RETRY_DELAY || 1000,
    maxRetries: config.DATABASE.POOL.CONNECTION_RETRY_MAX || 3
};

dbLogger.database('Initializing database pool', {
    config: {
        ...poolConfig,
        path: dbPath.replace(process.cwd(), '.') // Chemin relatif pour les logs
    }
});

// Initialisation du pool
const dbPool = new DuckDBPool(poolConfig);

// Fonction de fermeture des connexions avec logging
const closeConnections = async () => {
    dbLogger.database('Closing all database connections');
    
    try {
        await dbPool.close();
        dbLogger.database('All database connections closed successfully');
    } catch (error) {
        dbLogger.error('Error closing database connections', error);
        throw error;
    }
};

// Gestion des événements du pool (optionnel, si on ajoute des événements au pool)
if (dbPool.on) {
    dbPool.on('connection:created', (connectionId) => {
        dbLogger.database('New database connection created', { connectionId });
    });
    
    dbPool.on('connection:error', (error, connectionId) => {
        dbLogger.error('Database connection error', error, { connectionId });
    });
}

// Exportation du pool et de la fonction de clôture
export { dbPool, closeConnections };