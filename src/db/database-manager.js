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
 * DatabaseManager - Manages a shared DuckDB pool attached to multiple DuckLake catalogs.
 *
 * Each DuckLake catalog (one per ML pipeline / data source) is attached to a single
 * in-memory DuckDB instance under a distinct alias. GraphQL resolvers route queries
 * to the right catalog by prefixing table names:
 *   SELECT * FROM project_a.main.fact_table
 *
 * Configuration expected from config-loader.js:
 *   DATABASE_ROUTING:
 *     DEFAULT_DATABASE: 'project_a'
 *     ALLOWED_DATABASES: ['project_a', 'project_b']
 *     ALLOW_CROSS_DATABASE_QUERIES: true
 *   CATALOGS:
 *     project_a:
 *       PATH: 'outputs/project_a.ducklake'       # chemin relatif depuis la racine du projet
 *       DATA_PATH: 'outputs/project_a_data/'
 *       READ_ONLY: true
 *     project_b:
 *       PATH: 'outputs/project_b.ducklake'
 *       DATA_PATH: 'outputs/project_b_data/'
 *       READ_ONLY: true
 *   DATABASE:
 *     POOL:
 *       MAX_CONNECTIONS: 5
 *       ACQUIRE_TIMEOUT: 10000
 *       CONNECTION_RETRY_DELAY: 100
 *       POOL_RETRY_DELAY: 50
 */
class DatabaseManager {
    constructor() {
        // Configuration du routage des catalogues depuis le fichier de config
        this.defaultDatabase = config.DATABASE_ROUTING.DEFAULT_DATABASE;
        this.allowedDatabases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
        this.allowCrossDatabase = config.DATABASE_ROUTING.ALLOW_CROSS_DATABASE_QUERIES;

        // Pool partagé unique : un seul DuckDB en mémoire, tous les catalogues attachés
        this.sharedPool = null;

        // Initialisation automatique
        this.initializeDatabases();
    }

    /**
     * Build the catalog array and create the single shared DuckDB pool.
     * Each entry in config.CATALOGS becomes an ATTACH in the shared DuckDB instance.
     */
    initializeDatabases() {
        dbLogger.database('Initializing database manager', {
            defaultDatabase: this.defaultDatabase,
            allowedDatabases: this.allowedDatabases,
            allowCrossDatabase: this.allowCrossDatabase
        });

        // Construction de la liste des catalogues DuckLake à attacher
        const catalogs = [];

        for (const [catalogId, catalogConfig] of Object.entries(config.CATALOGS)) {
            // Résolution du chemin absolu vers le fichier catalogue (slashes pour DuckLake)
            const catalogPath = resolve(__dirname, '../../', catalogConfig.PATH).replace(/\\/g, '/');
            // Résolution du chemin absolu vers le répertoire de données Parquet
            const dataPathRaw = resolve(__dirname, '../../', catalogConfig.DATA_PATH).replace(/\\/g, '/');
            // DuckLake exige un slash final sur DATA_PATH
            const dataPath = dataPathRaw.endsWith('/') ? dataPathRaw : dataPathRaw + '/';

            // Vérification de l'existence du fichier catalogue
            if (!fs.existsSync(catalogPath)) {
                // Avertissement non bloquant : DuckLake peut initialiser un catalogue vide
                dbLogger.warn(`Catalog file not found for ${catalogId}`, {
                    path: catalogPath,
                    configPath: catalogConfig.PATH
                });
            } else {
                const stats = fs.statSync(catalogPath);
                dbLogger.database(`Catalog file found for ${catalogId}`, {
                    path: catalogPath,
                    size: stats.size,
                    modified: stats.mtime
                });
            }

            catalogs.push({
                alias: catalogId,
                path: catalogPath,
                dataPath: dataPath,
                readOnly: catalogConfig.READ_ONLY ?? true
            });
        }

        // Validation que le catalogue par défaut est bien dans la liste
        const defaultInCatalogs = catalogs.some(c => c.alias === this.defaultDatabase);
        if (!defaultInCatalogs) {
            throw new Error(
                `Default database '${this.defaultDatabase}' not found in CATALOGS config. ` +
                `Available: ${catalogs.map(c => c.alias).join(', ')}`
            );
        }

        // Création du pool partagé unique avec tous les catalogues
        const poolConfig = {
            catalogs,
            maxConnections: config.DATABASE.POOL.MAX_CONNECTIONS,
            acquireTimeout: config.DATABASE.POOL.ACQUIRE_TIMEOUT,
            retryDelay: config.DATABASE.POOL.POOL_RETRY_DELAY
        };

        dbLogger.database('Creating shared pool', {
            catalogs: catalogs.map(c => ({
                alias: c.alias,
                path: c.path.replace(process.cwd(), '.'),
                readOnly: c.readOnly
            })),
            maxConnections: poolConfig.maxConnections
        });

        this.sharedPool = new DuckDBPool(poolConfig);

        dbLogger.database('Database manager initialized successfully', {
            attachedCatalogs: catalogs.map(c => c.alias)
        });
    }

    /**
     * Get the shared connection pool.
     * Validates that the requested catalogId is allowed before returning the pool.
     * The caller is responsible for using catalog-qualified queries:
     *   SELECT * FROM {catalogId}.main.fact_table
     *
     * @param {string|null} catalogId - Catalog to validate access for (null = default).
     * @returns {DuckDBPool} The shared connection pool.
     * @throws {Error} If catalogId is not in ALLOWED_DATABASES.
     */
    getPool(catalogId = null) {
        // Utilisation du catalogue par défaut si aucun ID n'est spécifié
        const targetCatalog = catalogId || this.defaultDatabase;

        // Validation que le catalogue demandé est autorisé
        if (!this.isValidDatabase(targetCatalog)) {
            throw new Error(
                `Database '${targetCatalog}' is not allowed or not configured. ` +
                `Allowed: ${this.allowedDatabases.join(', ')}`
            );
        }

        return this.sharedPool;
    }

    /**
     * Validate if a catalog ID is in the allowed list.
     *
     * @param {string} catalogId - Catalog identifier to validate.
     * @returns {boolean} True if the catalog is allowed.
     */
    isValidDatabase(catalogId) {
        return this.allowedDatabases.includes(catalogId);
    }

    /**
     * Get list of allowed catalog IDs.
     *
     * @returns {Array<string>} List of allowed catalog identifiers.
     */
    getAvailableDatabases() {
        return [...this.allowedDatabases];
    }

    /**
     * Get default catalog ID.
     *
     * @returns {string} Default catalog identifier.
     */
    getDefaultDatabase() {
        return this.defaultDatabase;
    }

    /**
     * Check if cross-catalog queries are allowed.
     *
     * @returns {boolean} True if cross-catalog queries are allowed.
     */
    isCrossDatabaseAllowed() {
        return this.allowCrossDatabase;
    }

    /**
     * Validate and resolve the catalog ID for a GraphQL request.
     * Priority: explicit parameter > HTTP header context > default catalog.
     *
     * @param {string|null} requestedDatabase - Catalog requested by the client.
     * @param {string|null} contextDatabase - Catalog from request context (HTTP header).
     * @returns {string} Validated catalog ID to use.
     * @throws {Error} If the resolved catalog is not available.
     */
    validateDatabaseRouting(requestedDatabase = null, contextDatabase = null) {
        // Priorité : paramètre GraphQL > en-tête HTTP > catalogue par défaut
        const targetDatabase = requestedDatabase || contextDatabase || this.defaultDatabase;

        if (!this.isValidDatabase(targetDatabase)) {
            throw new Error(
                `Database '${targetDatabase}' is not available. ` +
                `Available databases: ${this.getAvailableDatabases().join(', ')}`
            );
        }

        return targetDatabase;
    }

    /**
     * Close the shared pool and all its connections.
     *
     * @returns {Promise<void>}
     */
    async close() {
        dbLogger.database('Closing shared database pool');

        if (this.sharedPool) {
            try {
                await this.sharedPool.close();
                this.sharedPool = null;
                dbLogger.database('Shared database pool closed successfully');
            } catch (error) {
                dbLogger.error('Error closing shared database pool', error);
                throw error;
            }
        }
    }

    /**
     * Get connection statistics for the shared pool.
     *
     * @returns {Object} Statistics for the shared pool and routing configuration.
     */
    getStatistics() {
        // Récupération des statistiques du pool partagé si disponible
        const poolStats = this.sharedPool ? {
            available: this.sharedPool.pool.filter(c => !c.inUse).length,
            using: this.sharedPool.pool.filter(c => c.inUse).length,
            total: this.sharedPool.pool.length,
            maxConnections: this.sharedPool.maxConnections,
            attachedCatalogs: (this.sharedPool.catalogs || []).map(c => c.alias)
        } : null;

        return {
            sharedPool: poolStats,
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
