// Injectable version of DatabaseManager for better testability
import path, { dirname, resolve } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DuckDBPool } from '../../src/db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Injectable DatabaseManager - Accepts configuration and logger as dependencies
 * This version doesn't create singleton instances at module load time
 */
class InjectableDatabaseManager {
  constructor(config, logger) {
    if (!config?.DATABASE_ROUTING) {
      throw new Error('DATABASE_ROUTING configuration is required');
    }
    
    this.config = config;
    this.logger = logger || this.createNullLogger();
    this.pools = new Map();
    
    // Configuration
    this.defaultDatabase = config.DATABASE_ROUTING.DEFAULT_DATABASE;
    this.allowedDatabases = config.DATABASE_ROUTING.ALLOWED_DATABASES;
    this.allowCrossDatabase = config.DATABASE_ROUTING.ALLOW_CROSS_DATABASE_QUERIES;
    
    // Auto-initialize if requested (default behavior)
    if (config.DATABASE_ROUTING.AUTO_INITIALIZE !== false) {
      this.initializeDatabases();
    }
  }

  createNullLogger() {
    return {
      database: () => {},
      warn: () => {},
      error: () => {},
      info: () => {}
    };
  }

  initializeDatabases() {
    this.logger.database('Initializing database manager', {
      defaultDatabase: this.defaultDatabase,
      allowedDatabases: this.allowedDatabases,
      allowCrossDatabase: this.allowCrossDatabase
    });

    for (const [databaseId, dbConfig] of Object.entries(this.config.DATABASES || {})) {
      try {
        this.initializeDatabase(databaseId, dbConfig);
      } catch (error) {
        this.logger.error(`Failed to initialize database ${databaseId}`, error);
        // Continue with other databases even if one fails
      }
    }

    // Validation that the default database was initialized successfully
    if (!this.pools.has(this.defaultDatabase)) {
      throw new Error(`Default database '${this.defaultDatabase}' failed to initialize`);
    }

    this.logger.database('Database manager initialized successfully', {
      initializedDatabases: Array.from(this.pools.keys())
    });
  }

  initializeDatabase(databaseId, dbConfig) {
    // Support both relative and absolute paths
    let dbPath;
    if (path.isAbsolute(dbConfig.PATH)) {
      dbPath = dbConfig.PATH;
    } else {
      dbPath = resolve(__dirname, '../../../', dbConfig.PATH);
    }

    // Check if database file exists
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

    // Create pool configuration
    const poolConfig = {
      path: dbPath,
      maxConnections: dbConfig.POOL.MAX_CONNECTIONS,
      acquireTimeout: dbConfig.POOL.ACQUIRE_TIMEOUT,
      retryDelay: dbConfig.POOL.CONNECTION_RETRY_DELAY,
      maxRetries: dbConfig.POOL.CONNECTION_RETRY_MAX
    };

    this.logger.database(`Initializing database pool for ${databaseId}`, {
      config: {
        ...poolConfig,
        path: dbPath.replace(process.cwd(), '.') // Relative path for logs
      }
    });

    // Create and store pool
    const pool = new DuckDBPool(poolConfig);
    this.pools.set(databaseId, pool);

    // Setup event listeners if pool supports them
    if (pool.on) {
      pool.on('connection:created', (connectionId) => {
        this.logger.database(`New database connection created for ${databaseId}`, { 
          databaseId, 
          connectionId 
        });
      });
      
      pool.on('connection:error', (error, connectionId) => {
        this.logger.error(`Database connection error for ${databaseId}`, error, { 
          databaseId, 
          connectionId 
        });
      });
    }
  }

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

  isValidDatabase(databaseId) {
    return this.allowedDatabases.includes(databaseId) && this.pools.has(databaseId);
  }

  getAvailableDatabases() {
    return Array.from(this.pools.keys());
  }

  getDefaultDatabase() {
    return this.defaultDatabase;
  }

  isCrossDatabaseAllowed() {
    return this.allowCrossDatabase;
  }

  validateDatabaseRouting(requestedDatabase = null, contextDatabase = null) {
    // Priority: GraphQL parameter > HTTP header > default
    const targetDatabase = requestedDatabase || contextDatabase || this.defaultDatabase;
    
    if (!this.isValidDatabase(targetDatabase)) {
      throw new Error(`Database '${targetDatabase}' is not available. Available databases: ${this.getAvailableDatabases().join(', ')}`);
    }

    return targetDatabase;
  }

  async close() {
    this.logger.database('Closing all database connections');
    
    const closePromises = Array.from(this.pools.entries()).map(async ([databaseId, pool]) => {
      try {
        await pool.close();
        this.logger.database(`Database pool closed for ${databaseId}`);
      } catch (error) {
        this.logger.error(`Error closing database pool for ${databaseId}`, error);
        throw error;
      }
    });

    await Promise.all(closePromises);
    this.pools.clear();
    
    this.logger.database('All database connections closed successfully');
  }

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

// Factory function for DI container
export const createDatabaseManager = (config, logger) => {
  return new InjectableDatabaseManager(config, logger);
};

export { InjectableDatabaseManager };
export default InjectableDatabaseManager;