// Importation des modules
import { databaseManager, closeAllConnections } from './database-manager.js';
import { createContextLogger } from '../utils/logger.js';

// Création du logger contextualisé pour ce module
const dbLogger = createContextLogger({
    component: 'database',
    module: 'connection'
});

// Fonction de compatibilité pour obtenir le pool par défaut
const getDefaultPool = () => {
    return databaseManager.getPool();
};

// Pool par défaut pour la compatibilité avec l'ancien code
const dbPool = getDefaultPool();

// Fonction de fermeture des connexions avec logging (compatibilité)
const closeConnections = async (): Promise<void> => {
    dbLogger.database('Closing all database connections (legacy function)');
    await closeAllConnections();
};

// Exportation pour compatibilité et nouvelles fonctionnalités
export {
    dbPool,
    closeConnections,
    databaseManager,
    closeAllConnections,
    getDefaultPool
};
