// Importation des modules nécessaires pour la gestion des bases de données
import { DuckDBPool } from './pool.js';
import { dirname, resolve } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// Résolution de l'emplacement du fichier et du dossier pour les chemins relatifs
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Création du logger contextualisé spécifique à ce module
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
        // Map pour stocker les pools de connexion de chaque base de données
        this.pools = new Map();
        
        // Configuration du routage des bases de données depuis le fichier de config
        this.defaultDatabase = config.DATABASE_ROUTING.DEFAULT_DATABASE;
        this.allowedDatabases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
        this.allowCrossDatabase = config.DATABASE_ROUTING.ALLOW_CROSS_DATABASE_QUERIES;
        
        // Initialisation automatique de toutes les bases de données configurées
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

        // Initialisation de chaque base de données configurée dans le fichier de config
        for (const [databaseId, dbConfig] of Object.entries(config.DATABASES)) {
            try {
                // Tentative d'initialisation de la base de données
                this.initializeDatabase(databaseId, dbConfig);
            } catch (error) {
                // Log de l'erreur mais continuation du processus pour les autres bases
                dbLogger.error(`Failed to initialize database ${databaseId}`, error);
                // Continuer avec les autres bases de données même si une échoue
            }
        }

        // Validation que la base de données par défaut a été initialisée avec succès
        if (!this.pools.has(this.defaultDatabase)) {
            throw new Error(`Default database '${this.defaultDatabase}' failed to initialize`);
        }

        // Log de confirmation de l'initialisation réussie
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
        // Construction du chemin absolu vers la base de données à partir du chemin relatif configuré
        const dbPath = resolve(__dirname, '../../', dbConfig.PATH);

        // Vérification de l'existence du fichier de base de données
        if (!fs.existsSync(dbPath)) {
            // Avertissement mais pas d'erreur - DuckDB peut créer le fichier automatiquement
            dbLogger.warn(`Database file not found for ${databaseId}`, {
                path: dbPath,
                configPath: dbConfig.PATH
            });
            // On continue quand même car DuckDB peut créer le fichier si nécessaire
        } else {
            // Log des informations du fichier existant (taille, date de modification)
            const stats = fs.statSync(dbPath);
            dbLogger.database(`Database file found for ${databaseId}`, {
                path: dbPath,
                size: stats.size,
                modified: stats.mtime
            });
        }

        // Préparation de la configuration du pool de connexions avec les paramètres du fichier config
        const poolConfig = {
            path: dbPath,
            maxConnections: dbConfig.POOL.MAX_CONNECTIONS,
            acquireTimeout: dbConfig.POOL.ACQUIRE_TIMEOUT,
            retryDelay: dbConfig.POOL.CONNECTION_RETRY_DELAY,
            maxRetries: dbConfig.POOL.CONNECTION_RETRY_MAX
        };

        // Log de la configuration avant initialisation du pool
        dbLogger.database(`Initializing database pool for ${databaseId}`, {
            config: {
                ...poolConfig,
                path: dbPath.replace(process.cwd(), '.') // Chemin relatif pour les logs (plus lisible)
            }
        });

        // Création et stockage du pool de connexions dans la Map
        const pool = new DuckDBPool(poolConfig);
        this.pools.set(databaseId, pool);

        // Configuration des écouteurs d'événements du pool pour le monitoring
        if (pool.on) {
            // Événement de création de nouvelle connexion
            pool.on('connection:created', (connectionId) => {
                dbLogger.database(`New database connection created for ${databaseId}`, { 
                    databaseId, 
                    connectionId 
                });
            });
            
            // Événement d'erreur de connexion
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
        // Utilisation de la base par défaut si aucun ID n'est spécifié
        const targetDatabase = databaseId || this.defaultDatabase;
        
        // Validation que la base demandée est autorisée et configurée
        if (!this.isValidDatabase(targetDatabase)) {
            throw new Error(`Database '${targetDatabase}' is not allowed or configured`);
        }

        // Récupération du pool depuis la Map
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