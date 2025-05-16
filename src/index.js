// Importation des modules
import 'dotenv/config';
import { startServer } from './server.js';

// Fonction principale de lancement du server
/**
 * Main entry point for the GraphQL API server
 * Starts the server and handles uncaught exceptions
 */
async function main() {
  try {
    await startServer();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Gestion globale des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  // Fermeture propre du serveur
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Lancement du serveur
main();