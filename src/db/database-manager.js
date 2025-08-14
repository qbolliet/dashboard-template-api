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
    module: 'database-manager'
});

/**
 * DatabaseManager - Manages multiple database connections
 * Handles connection pools for different databases and provides routing logic
 */
class DatabaseManager {
    constructor() {
        this.pools = new Map();
        this.defaultDatabase = config.DATABASE_ROUTING.DEFAULT_DATABASE;
        this.allowedDatabases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
        this.allowCrossDatabase = config.DATABASE_ROUTING.ALLOW_CROSS_DATABASE_QUERIES;
        
        this.initializeDatabases();
    }

    /**
     * Initialize all database connections from configuration
     */
    initializeDatabases() {
        dbLogger.database('Initializing database manager', {
            defaultDatabase: this.defaultDatabase,
            allowedDatabases: this.allowedDatabases,
            allowCrossDatabase: this.allowCrossDatabase
        });

        // Initialize each configured database
        for (const [databaseId, dbConfig] of Object.entries(config.DATABASES)) {
            try {
                this.initializeDatabase(databaseId, dbConfig);
            } catch (error) {
                dbLogger.error(`Failed to initialize database ${databaseId}`, error);
                // Continue with other databases even if one fails
            }
        }

        // Validate that default database was initialized
        if (!this.pools.has(this.defaultDatabase)) {
            throw new Error(`Default database '${this.defaultDatabase}' failed to initialize`);
        }

        dbLogger.database('Database manager initialized successfully', {
            initializedDatabases: Array.from(this.pools.keys())
        });
    }

    /**
     * Initialize a single database connection pool
     * @param {string} databaseId - Database identifier
     * @param {Object} dbConfig - Database configuration
     */
    initializeDatabase(databaseId, dbConfig) {
        // Construction du chemin vers la base de données
        const dbPath = resolve(__dirname, '../../', dbConfig.PATH);

        // Vérification que le chemin vers la base de données existe
        if (!fs.existsSync(dbPath)) {
            dbLogger.warn(`Database file not found for ${databaseId}`, {
                path: dbPath,
                configPath: dbConfig.PATH
            });
            // On continue quand même car DuckDB peut créer le fichier
        } else {
            const stats = fs.statSync(dbPath);
            dbLogger.database(`Database file found for ${databaseId}`, {
                path: dbPath,
                size: stats.size,
                modified: stats.mtime
            });
        }

        // Initialisation de la connection pool avec les paramètres de configuration
        const poolConfig = {
            path: dbPath,
            maxConnections: dbConfig.POOL.MAX_CONNECTIONS,
            acquireTimeout: dbConfig.POOL.ACQUIRE_TIMEOUT,
            retryDelay: dbConfig.POOL.CONNECTION_RETRY_DELAY,
            maxRetries: dbConfig.POOL.CONNECTION_RETRY_MAX
        };

        dbLogger.database(`Initializing database pool for ${databaseId}`, {
            config: {
                ...poolConfig,
                path: dbPath.replace(process.cwd(), '.') // Chemin relatif pour les logs
            }
        });

        // Créer et stocker le pool
        const pool = new DuckDBPool(poolConfig);
        this.pools.set(databaseId, pool);

        // Gestion des événements du pool
        if (pool.on) {
            pool.on('connection:created', (connectionId) => {
                dbLogger.database(`New database connection created for ${databaseId}`, { 
                    databaseId, 
                    connectionId 
                });
            });
            
            pool.on('connection:error', (error, connectionId) => {
                dbLogger.error(`Database connection error for ${databaseId}`, error, { 
                    databaseId, 
                    connectionId 
                });
            });
        }
    }

    /**
     * Get database pool for a specific database
     * @param {string} databaseId - Database identifier (optional, defaults to default database)
     * @returns {DuckDBPool} Database connection pool
     */
    getPool(databaseId = null) {
        const targetDatabase = databaseId || this.defaultDatabase;
        
        if (!this.isValidDatabase(targetDatabase)) {
            throw new Error(`Database '${targetDatabase}' is not allowed or configured`);
        }

        const pool = this.pools.get(targetDatabase);
        if (!pool) {
            throw new Error(`Database pool for '${targetDatabase}' not found`);
        }

        return pool;
    }

    /**
     * Validate if a database ID is allowed and configured
     * @param {string} databaseId - Database identifier to validate
     * @returns {boolean} True if database is valid
     */
    isValidDatabase(databaseId) {
        return this.allowedDatabases.includes(databaseId) && this.pools.has(databaseId);
    }

    /**
     * Get list of available databases
     * @returns {Array<string>} List of available database IDs
     */
    getAvailableDatabases() {
        return Array.from(this.pools.keys());
    }

    /**
     * Get default database ID
     * @returns {string} Default database identifier
     */
    getDefaultDatabase() {
        return this.defaultDatabase;
    }

    /**
     * Check if cross-database queries are allowed
     * @returns {boolean} True if cross-database queries are allowed
     */
    isCrossDatabaseAllowed() {
        return this.allowCrossDatabase;
    }

    /**
     * Validate database routing request
     * @param {string} requestedDatabase - Database requested by client
     * @param {string} contextDatabase - Database from request context
     * @returns {string} Validated database ID to use
     */
    validateDatabaseRouting(requestedDatabase = null, contextDatabase = null) {
        // Priority: GraphQL parameter > HTTP header > default
        const targetDatabase = requestedDatabase || contextDatabase || this.defaultDatabase;
        
        if (!this.isValidDatabase(targetDatabase)) {
            throw new Error(`Database '${targetDatabase}' is not available. Available databases: ${this.getAvailableDatabases().join(', ')}`);
        }

        return targetDatabase;
    }

    /**
     * Close all database connections
     */
    async close() {
        dbLogger.database('Closing all database connections');
        
        const closePromises = Array.from(this.pools.entries()).map(async ([databaseId, pool]) => {
            try {
                await pool.close();
                dbLogger.database(`Database pool closed for ${databaseId}`);
            } catch (error) {
                dbLogger.error(`Error closing database pool for ${databaseId}`, error);
                throw error;
            }
        });

        await Promise.all(closePromises);
        this.pools.clear();
        
        dbLogger.database('All database connections closed successfully');
    }


    /**
     * Get database connection statistics
     * @returns {Object} Statistics for all databases
     */
    getStatistics() {
        const stats = {};
        
        for (const [databaseId, pool] of this.pools.entries()) {
            stats[databaseId] = {
                available: pool.available || 0,
                using: pool.using || 0,
                waiting: pool.waiting || 0
            };
        }

        return {
            databases: stats,
            defaultDatabase: this.defaultDatabase,
            allowedDatabases: this.allowedDatabases,
            allowCrossDatabase: this.allowCrossDatabase
        };
    }
}

// Création de l'instance singleton du gestionnaire de base de données
const databaseManager = new DatabaseManager();

// Fonction de fermeture des connexions avec logging
const closeAllConnections = async () => {
    await databaseManager.close();
};

// Exportation du gestionnaire et de la fonction de clôture
export { databaseManager, closeAllConnections, DatabaseManager };