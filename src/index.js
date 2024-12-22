// Importation des modules
require('dotenv').config();
const { startServer } = require('./server');

// Lancement du serveur
async function main() {
  try {
    await startServer();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();