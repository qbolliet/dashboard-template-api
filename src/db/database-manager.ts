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

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Shared pool statistics returned by {@link DatabaseManager.getStatistics}. */
interface PoolStats {
    available: number;
    using: number;
    total: number;
    maxConnections: number;
    attachedCatalogs: string[];
}

/** Full statistics snapshot for the database manager. */
interface DatabaseStats {
    sharedPool: PoolStats | null;
    defaultDatabase: string;
    allowedDatabases: string[];
    allowCrossDatabase: boolean;
}

// ─── Classe DatabaseManager ───────────────────────────────────────────────────

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
 *       PATH: 'outputs/project_a.ducklake'
 *       DATA_PATH: 'outputs/project_a_data/'
 *       READ_ONLY: true
 *   DATABASE:
 *     POOL:
 *       MAX_CONNECTIONS: 5
 *       ACQUIRE_TIMEOUT: 10000
 *       POOL_RETRY_DELAY: 50
 */
class DatabaseManager {
    private readonly defaultDatabase: string;
    private readonly allowedDatabases: string[];
    private readonly allowCrossDatabase: boolean;
    private sharedPool: DuckDBPool | null;
    private readonly schemas: Record<string, string>;

    constructor() {
        // Configuration du routage des catalogues depuis le fichier de config
        this.defaultDatabase = config.DATABASE_ROUTING.DEFAULT_DATABASE;

        // ALLOWED_DATABASES peut être une string JSON ou un tableau selon le config-loader
        const rawAllowed = config.DATABASE_ROUTING.ALLOWED_DATABASES;
        this.allowedDatabases =
            typeof rawAllowed === 'string'
                ? (JSON.parse(rawAllowed) as string[])
                : rawAllowed;

        this.allowCrossDatabase =
            config.DATABASE_ROUTING.ALLOW_CROSS_DATABASE_QUERIES;

        // Pool partagé unique : un seul DuckDB en mémoire, tous les catalogues attachés
        this.sharedPool = null;

        // Map catalogId -> schéma DuckLake (configurable via SCHEMA dans database.yaml)
        this.schemas = {};

        // Initialisation automatique
        this.initializeDatabases();
    }

    /**
     * Build the catalog array and create the single shared DuckDB pool.
     * Each entry in config.CATALOGS becomes an ATTACH in the shared DuckDB instance.
     */
    initializeDatabases(): void {
        dbLogger.database('Initializing database manager', {
            defaultDatabase: this.defaultDatabase,
            allowedDatabases: this.allowedDatabases,
            allowCrossDatabase: this.allowCrossDatabase
        });

        // Construction de la liste des catalogues DuckLake à attacher
        const catalogs: { alias: string; path: string; dataPath: string; readOnly: boolean }[] = [];

        for (const [catalogId, catalogConfig] of Object.entries(config.CATALOGS)) {
            // Résolution du chemin absolu vers le fichier catalogue
            const catalogPath = resolve(__dirname, '../../', catalogConfig.PATH).replace(
                /\\/g,
                '/'
            );
            // Résolution du chemin absolu vers le répertoire de données Parquet
            const dataPathRaw = resolve(
                __dirname,
                '../../',
                catalogConfig.DATA_PATH
            ).replace(/\\/g, '/');
            // DuckLake exige un slash final sur DATA_PATH
            const dataPath = dataPathRaw.endsWith('/') ? dataPathRaw : dataPathRaw + '/';

            // Stockage du schéma DuckLake configuré pour ce catalogue
            this.schemas[catalogId] = catalogConfig.SCHEMA ?? 'main';

            // Vérification de l'existence du fichier catalogue
            if (!fs.existsSync(catalogPath)) {
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
        const defaultInCatalogs = catalogs.some((c) => c.alias === this.defaultDatabase);
        if (!defaultInCatalogs) {
            throw new Error(
                `Default database '${this.defaultDatabase}' not found in CATALOGS config. ` +
                    `Available: ${catalogs.map((c) => c.alias).join(', ')}`
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
            catalogs: catalogs.map((c) => ({
                alias: c.alias,
                path: c.path.replace(process.cwd(), '.'),
                readOnly: c.readOnly
            })),
            maxConnections: poolConfig.maxConnections
        });

        this.sharedPool = new DuckDBPool(poolConfig);

        dbLogger.database('Database manager initialized successfully', {
            attachedCatalogs: catalogs.map((c) => c.alias)
        });
    }

    /**
     * Get the shared connection pool.
     * Validates that the requested catalogId is allowed before returning the pool.
     *
     * @param catalogId - Catalog to validate access for (null = default).
     * @returns The shared connection pool.
     * @throws {Error} If catalogId is not in ALLOWED_DATABASES.
     */
    getPool(catalogId: string | null = null): DuckDBPool {
        const targetCatalog = catalogId ?? this.defaultDatabase;

        if (!this.isValidDatabase(targetCatalog)) {
            throw new Error(
                `Database '${targetCatalog}' is not allowed or not configured. ` +
                    `Allowed: ${this.allowedDatabases.join(', ')}`
            );
        }

        if (!this.sharedPool) {
            throw new Error('Shared pool is not initialized.');
        }

        return this.sharedPool;
    }

    /**
     * Validate if a catalog ID is in the allowed list.
     *
     * @param catalogId - Catalog identifier to validate.
     * @returns True if the catalog is allowed.
     */
    isValidDatabase(catalogId: string): boolean {
        return this.allowedDatabases.includes(catalogId);
    }

    /**
     * Get list of allowed catalog IDs.
     *
     * @returns List of allowed catalog identifiers.
     */
    getAvailableDatabases(): string[] {
        return [...this.allowedDatabases];
    }

    /**
     * Get default catalog ID.
     *
     * @returns Default catalog identifier.
     */
    getDefaultDatabase(): string {
        return this.defaultDatabase;
    }

    /**
     * Get the DuckLake schema name for a catalog.
     * Defaults to 'main' if not configured.
     *
     * @param catalogId - Catalog identifier.
     * @returns Schema name (e.g. 'main').
     */
    getSchema(catalogId: string): string {
        return (
            this.schemas[catalogId] ??
            this.schemas[this.defaultDatabase] ??
            'main'
        );
    }

    /**
     * Check if cross-catalog queries are allowed.
     *
     * @returns True if cross-catalog queries are allowed.
     */
    isCrossDatabaseAllowed(): boolean {
        return this.allowCrossDatabase;
    }

    /**
     * Validate and resolve the catalog ID for a GraphQL request.
     * Priority: explicit parameter > HTTP header context > default catalog.
     *
     * @param requestedDatabase - Catalog requested by the client.
     * @param contextDatabase - Catalog from request context (HTTP header).
     * @returns Validated catalog ID to use.
     * @throws {Error} If the resolved catalog is not available.
     */
    validateDatabaseRouting(
        requestedDatabase: string | null = null,
        contextDatabase: string | null = null
    ): string {
        // Priorité : paramètre GraphQL > en-tête HTTP > catalogue par défaut
        // Utilisation de || pour traiter les chaînes vides comme absentes
        const targetDatabase =
            requestedDatabase || contextDatabase || this.defaultDatabase;

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
     */
    async close(): Promise<void> {
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
     * @returns Statistics for the shared pool and routing configuration.
     */
    getStatistics(): DatabaseStats {
        // Récupération des statistiques du pool partagé si disponible
        const poolStats: PoolStats | null = this.sharedPool
            ? {
                  available: this.sharedPool.pool.filter((c) => !c.inUse).length,
                  using: this.sharedPool.pool.filter((c) => c.inUse).length,
                  total: this.sharedPool.pool.length,
                  maxConnections: this.sharedPool.maxConnections,
                  attachedCatalogs: (this.sharedPool.catalogs ?? []).map(
                      (c) => c.alias
                  )
              }
            : null;

        return {
            sharedPool: poolStats,
            defaultDatabase: this.defaultDatabase,
            allowedDatabases: this.allowedDatabases,
            allowCrossDatabase: this.allowCrossDatabase
        };
    }
}

// Création de l'instance singleton du gestionnaire de base de données
/** Singleton instance of the database manager used throughout the application. */
const databaseManager = new DatabaseManager();

/** Closes all open connections by delegating to {@link DatabaseManager.close}. */
// Fonction de fermeture des connexions avec logging
const closeAllConnections = async (): Promise<void> => {
    await databaseManager.close();
};

// Exportation du gestionnaire et de la fonction de clôture
export { databaseManager, closeAllConnections, DatabaseManager };
