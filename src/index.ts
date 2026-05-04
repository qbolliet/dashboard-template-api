// Importation des modules
import 'dotenv/config';
import { startServer } from './server.js';

// Point d'entrée principal de l'API GraphQL
/**
 * Main entry point for the GraphQL API server.
 *
 * Starts the server and handles any uncaught startup exceptions by
 * logging the error and exiting the process with a non-zero code.
 *
 * Returns:
 *     A promise that resolves when the server is listening.
 */
async function main(): Promise<void> {
    try {
        await startServer();
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Gestion globale des exceptions non capturées
process.on('uncaughtException', (error: Error): void => {
    console.error('Uncaught exception:', error);
    // Fermeture propre du processus sur exception non rattrapée
    process.exit(1);
});

// Gestion globale des rejets de promesses non gérés
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>): void => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Lancement du serveur
void main();
