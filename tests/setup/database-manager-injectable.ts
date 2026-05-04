/**
 * Injectable DatabaseManager for test environments.
 *
 * Wraps DuckDBPool without creating singleton instances at module load time,
 * allowing full dependency injection of configuration and logger in tests.
 */

// Version injectable du DatabaseManager — meilleure testabilité par injection de dépendances.
import path, { dirname, resolve } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DuckDBPool } from '../../src/db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Interfaces et types ───────────────────────────────────────────────────────

/** Configuration du pool de connexions pour une base de données. */
interface PoolSettings {
  MAX_CONNECTIONS: number;
  ACQUIRE_TIMEOUT: number;
  CONNECTION_RETRY_DELAY: number;
  CONNECTION_RETRY_MAX: number;
}

/** Configuration d'une base de données individuelle. */
interface DatabaseEntry {
  PATH: string;
  POOL: PoolSettings;
}

/** Configuration du routage des bases de données. */
interface DatabaseRoutingConfig {
  DEFAULT_DATABASE: string;
  ALLOWED_DATABASES: string[];
  ALLOW_CROSS_DATABASE_QUERIES: boolean;
  AUTO_INITIALIZE?: boolean;
}

/** Configuration complète injectée dans le manager. */
interface DatabaseManagerConfig {
  DATABASE_ROUTING: DatabaseRoutingConfig;
  DATABASES?: Record<string, DatabaseEntry>;
}

/** Interface minimale du logger injecté. */
interface DatabaseLogger {
  database: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, error?: unknown, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
}

/** Configuration transmise au constructeur de DuckDBPool. */
interface PoolConfig {
  path: string;
  maxConnections: number;
  acquireTimeout: number;
  retryDelay: number;
  maxRetries: number;
}

/** Statistiques de connexion d'un pool. */
interface PoolStats {
  available: number;
  using: number;
  waiting: number;
}

/** Statistiques agrégées de toutes les bases de données gérées. */
interface DatabaseStatistics {
  databases: Record<string, PoolStats>;
  defaultDatabase: string;
  allowedDatabases: string[];
  allowCrossDatabase: boolean;
}

// ─── Classe principale ─────────────────────────────────────────────────────────

/**
 * Injectable version of DatabaseManager.
 *
 * Accepts configuration and logger as constructor dependencies instead of
 * reading them from the module-level singleton, making it safe to instantiate
 * multiple independent instances within the same test suite.
 *
 * Example:
 *   const manager = new InjectableDatabaseManager(testConfig, nullLogger);
 *   const pool = manager.getPool('default');
 */
class InjectableDatabaseManager {
  private config: DatabaseManagerConfig;
  private logger: DatabaseLogger;
  private pools: Map<string, InstanceType<typeof DuckDBPool>>;
  private defaultDatabase: string;
  private allowedDatabases: string[];
  private allowCrossDatabase: boolean;

  constructor(config: DatabaseManagerConfig, logger?: Partial<DatabaseLogger>) {
    if (!config?.DATABASE_ROUTING) {
      throw new Error('DATABASE_ROUTING configuration is required');
    }

    this.config = config;
    this.logger = (logger as DatabaseLogger) ?? this.createNullLogger();
    this.pools = new Map();

    // Extraction des paramètres de routage depuis la configuration
    this.defaultDatabase = config.DATABASE_ROUTING.DEFAULT_DATABASE;
    this.allowedDatabases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
    this.allowCrossDatabase = config.DATABASE_ROUTING.ALLOW_CROSS_DATABASE_QUERIES;

    // Initialisation automatique si non désactivée explicitement
    if (config.DATABASE_ROUTING.AUTO_INITIALIZE !== false) {
      this.initializeDatabases();
    }
  }

  /**
   * Create a null logger that discards all log messages.
   *
   * Returns:
   *     A DatabaseLogger implementation with no-op methods.
   */
  private createNullLogger(): DatabaseLogger {
    // Logger silencieux — suppression de tous les messages pendant les tests
    return {
      database: (): void => {},
      warn: (): void => {},
      error: (): void => {},
      info: (): void => {}
    };
  }

  /**
   * Initialize all configured database pools from the injected configuration.
   *
   * Raises:
   *     Error: When the default database fails to initialize.
   */
  private initializeDatabases(): void {
    this.logger.database('Initializing database manager', {
      defaultDatabase: this.defaultDatabase,
      allowedDatabases: this.allowedDatabases,
      allowCrossDatabase: this.allowCrossDatabase
    });

    // Initialisation de chaque base de données configurée
    for (const [databaseId, dbConfig] of Object.entries(this.config.DATABASES ?? {})) {
      try {
        this.initializeDatabase(databaseId, dbConfig);
      } catch (error) {
        this.logger.error(`Failed to initialize database ${databaseId}`, error);
        // Continuation avec les autres bases même en cas d'échec partiel
      }
    }

    // Validation de l'initialisation de la base de données par défaut
    if (!this.pools.has(this.defaultDatabase)) {
      throw new Error(`Default database '${this.defaultDatabase}' failed to initialize`);
    }

    this.logger.database('Database manager initialized successfully', {
      initializedDatabases: Array.from(this.pools.keys())
    });
  }

  /**
   * Initialize a single database pool from its configuration entry.
   *
   * Args:
   *     databaseId: Identifier key for this database.
   *     dbConfig: Configuration object for this database.
   */
  private initializeDatabase(databaseId: string, dbConfig: DatabaseEntry): void {
    // Résolution du chemin absolu ou relatif vers le fichier de base de données
    let dbPath: string;
    if (path.isAbsolute(dbConfig.PATH)) {
      dbPath = dbConfig.PATH;
    } else {
      dbPath = resolve(__dirname, '../../../', dbConfig.PATH);
    }

    // Vérification de l'existence du fichier de base de données
    if (!fs.existsSync(dbPath)) {
      this.logger.warn(`Database file not found for ${databaseId}`, {
        path: dbPath,
        configPath: dbConfig.PATH
      });
    } else {
      const stats = fs.statSync(dbPath);
      this.logger.database(`Database file found for ${databaseId}`, {
        path: dbPath,
        size: stats.size,
        modified: stats.mtime
      });
    }

    // Construction de la configuration du pool
    const poolConfig: PoolConfig = {
      path: dbPath,
      maxConnections: dbConfig.POOL.MAX_CONNECTIONS,
      acquireTimeout: dbConfig.POOL.ACQUIRE_TIMEOUT,
      retryDelay: dbConfig.POOL.CONNECTION_RETRY_DELAY,
      maxRetries: dbConfig.POOL.CONNECTION_RETRY_MAX
    };

    this.logger.database(`Initializing database pool for ${databaseId}`, {
      config: {
        ...poolConfig,
        path: dbPath.replace(process.cwd(), '.') // Chemin relatif pour les logs
      }
    });

    // Création et stockage du pool de connexions
    const pool = new DuckDBPool(poolConfig);
    this.pools.set(databaseId, pool);

    // Abonnement aux événements du pool si supporté
    if (pool.on) {
      pool.on('connection:created', (connectionId: unknown) => {
        this.logger.database(`New database connection created for ${databaseId}`, {
          databaseId,
          connectionId
        });
      });

      pool.on('connection:error', (error: unknown, connectionId: unknown) => {
        this.logger.error(
          `Database connection error for ${databaseId}`,
          error,
          { databaseId, connectionId }
        );
      });
    }
  }

  /**
   * Retrieve the connection pool for the specified database.
   *
   * Args:
   *     databaseId: Target database identifier, or null for the default.
   *
   * Returns:
   *     The DuckDBPool instance for the requested database.
   *
   * Raises:
   *     Error: When the database is not allowed or its pool is missing.
   */
  getPool(databaseId: string | null = null): InstanceType<typeof DuckDBPool> {
    const targetDatabase = databaseId ?? this.defaultDatabase;

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
   * Check whether a database is both allowed and has an active pool.
   *
   * Args:
   *     databaseId: Database identifier to validate.
   *
   * Returns:
   *     True if the database is allowed and initialized.
   */
  isValidDatabase(databaseId: string): boolean {
    return this.allowedDatabases.includes(databaseId) && this.pools.has(databaseId);
  }

  /**
   * Return the list of database identifiers that have active pools.
   *
   * Returns:
   *     Array of initialized database identifiers.
   */
  getAvailableDatabases(): string[] {
    return Array.from(this.pools.keys());
  }

  /**
   * Return the identifier of the default database.
   *
   * Returns:
   *     Default database identifier string.
   */
  getDefaultDatabase(): string {
    return this.defaultDatabase;
  }

  /**
   * Check whether cross-database queries are permitted.
   *
   * Returns:
   *     True if cross-database queries are allowed by configuration.
   */
  isCrossDatabaseAllowed(): boolean {
    return this.allowCrossDatabase;
  }

  /**
   * Validate and resolve the target database from routing parameters.
   *
   * Priority order: explicit parameter > context header > default database.
   *
   * Args:
   *     requestedDatabase: Database requested via GraphQL parameter.
   *     contextDatabase: Database inferred from HTTP context/header.
   *
   * Returns:
   *     Validated target database identifier.
   *
   * Raises:
   *     Error: When the resolved database is not available.
   */
  validateDatabaseRouting(
    requestedDatabase: string | null = null,
    contextDatabase: string | null = null
  ): string {
    // Priorité : paramètre GraphQL > en-tête HTTP > base par défaut
    const targetDatabase = requestedDatabase ?? contextDatabase ?? this.defaultDatabase;

    if (!this.isValidDatabase(targetDatabase)) {
      throw new Error(
        `Database '${targetDatabase}' is not available. Available databases: ${this.getAvailableDatabases().join(', ')}`
      );
    }

    return targetDatabase;
  }

  /**
   * Close all database connection pools and clear the pool registry.
   *
   * Raises:
   *     Error: When any pool fails to close gracefully.
   */
  async close(): Promise<void> {
    this.logger.database('Closing all database connections');

    // Fermeture parallèle de tous les pools
    const closePromises = Array.from(this.pools.entries()).map(
      async ([databaseId, pool]) => {
        try {
          await pool.close();
          this.logger.database(`Database pool closed for ${databaseId}`);
        } catch (error) {
          this.logger.error(`Error closing database pool for ${databaseId}`, error);
          throw error;
        }
      }
    );

    await Promise.all(closePromises);
    this.pools.clear();

    this.logger.database('All database connections closed successfully');
  }

  /**
   * Return connection statistics for all managed databases.
   *
   * Returns:
   *     Statistics object with per-database pool metrics and routing configuration.
   */
  getStatistics(): DatabaseStatistics {
    const stats: Record<string, PoolStats> = {};

    // Collecte des métriques de chaque pool
    for (const [databaseId, pool] of this.pools.entries()) {
      stats[databaseId] = {
        available: (pool as unknown as { available?: number }).available ?? 0,
        using: (pool as unknown as { using?: number }).using ?? 0,
        waiting: (pool as unknown as { waiting?: number }).waiting ?? 0
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

// ─── Factory et exports ────────────────────────────────────────────────────────

/**
 * Factory function for use with the DI container.
 *
 * Args:
 *     config: Database manager configuration.
 *     logger: Logger instance to inject.
 *
 * Returns:
 *     A new InjectableDatabaseManager instance.
 */
export const createDatabaseManager = (
  config: DatabaseManagerConfig,
  logger?: Partial<DatabaseLogger>
): InjectableDatabaseManager => {
  return new InjectableDatabaseManager(config, logger);
};

export { InjectableDatabaseManager };
export type { DatabaseManagerConfig, DatabaseLogger, DatabaseStatistics };
export default InjectableDatabaseManager;
