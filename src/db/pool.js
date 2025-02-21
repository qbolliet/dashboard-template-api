// Importation des modules
const duckdb = require('duckdb');
const { promisify } = require('util');

// Ensemble de connections
class DuckDBPool {
    constructor(config) {
      this.config = config;
      this.pool = [];
      this.maxConnections = config.maxConnections || 10;
      this.acquireTimeout = config.acquireTimeout || 10000; // 10 seconds
    }
    
    // Acquisition de la connexion
    async acquire() {
        const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error('Connection acquisition timeout'));
        }, this.acquireTimeout);
        });

        const acquirePromise = new Promise(async (resolve, reject) => {
        // Regarde si une nouvelle connexion existe déjà
        const connection = this.pool.find(conn => !conn.inUse);
        if (connection) {
            connection.inUse = true;
            return resolve(connection);
        }

        // Créer une nouvelle connexion si l'ensemnle n'est pas plein
        if (this.pool.length < this.maxConnections) {
            try {
                // Connexion
                const db = new duckdb.Database(this.config.path);
                // Promet la méthode de connexion
                const connect = promisify(db.connect.bind(db));
                const conn = await connect();
                // Création de la connexion
                const newConnection = { 
                    db,
                    conn,
                    inUse: true,
                    // Promet les autres méthodes nécessaires
                    all: promisify(conn.all.bind(conn)),
                    exec: promisify(conn.exec.bind(conn)),
                    prepare: promisify(conn.prepare.bind(conn))
                };
                
                this.pool.push(newConnection);
                resolve(newConnection);
            } catch (error) {
                reject(error);
            }
        } else {
            // Attente d'une connexion disponible
            const checkInterval = setInterval(() => {
            const availableConnection = this.pool.find(conn => !conn.inUse);
            if (availableConnection) {
                clearInterval(checkInterval);
                availableConnection.inUse = true;
                resolve(availableConnection);
            }
            }, 100);
        }
        });

        return Promise.race([acquirePromise, timeoutPromise]);
    }

    // Publication de la connexion
    release(db) {
        const connection = this.pool.find(conn => conn.db === db);
        if (connection) {
        connection.inUse = false;
        }
    }

    // Arrêt de la connexion
    async close() {
        await Promise.all(this.pool.map(async (conn) => {
            try {
                await promisify(conn.db.close.bind(conn.db))();
            } catch (error) {
                console.error('Error closing connection:', error);
            }
        }));
        this.pool = [];
    }
}

exports.DuckDBPool = DuckDBPool;