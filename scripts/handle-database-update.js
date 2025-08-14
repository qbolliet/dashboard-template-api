#!/usr/bin/env node

/**
 * Database update handling script
 * This script should be called after daily database updates to:
 * 1. Invalidate relevant caches
 * 2. Warm up critical caches  
 * 3. Log the update process
 * 
 * Note: Database health checks are handled by external scripts
 */

import { config } from '../src/utils/config-loader.js';
import { cacheInvalidationManager } from '../src/cache/cache-invalidation.js';
import { createLoaders } from '../src/loaders/index.js';
import { logger } from '../src/utils/logger.js';

class DatabaseUpdateHandler {
    constructor() {
        // Horodatage de début pour mesurer la durée totale du processus
        this.startTime = Date.now();
        
        // Structure pour stocker les résultats de chaque étape
        this.results = {
            cacheInvalidation: {},
            cacheWarming: {},
            errors: []
        };
    }

    /**
     * Main update handling process
     */
    async handleUpdate(options = {}) {
        const {
            databases = null, // null signifie toutes les bases de données
            skipCacheInvalidation = false,
            skipCacheWarming = false,
            dryRun = false
        } = options;

        logger.info('Starting database update handling', {
            databases: databases || 'all',
            dryRun,
            options
        });

        try {
            // Étape 1: Invalidation du cache
            if (!skipCacheInvalidation && !dryRun) {
                await this.invalidateCaches(databases);
            }

            // Étape 2: Réchauffement du cache (optionnel)  
            if (!skipCacheWarming && !dryRun) {
                await this.warmUpCaches(databases);
            }

            // Étape 3: Résumé final
            this.logResults();

        } catch (error) {
            // Gestion des erreurs globales avec logging
            logger.error('Database update handling failed', error);
            this.results.errors.push(error.message);
            throw error;
        }
    }

    /**
     * Invalidate caches for updated databases
     */
    async invalidateCaches(databases) {
        logger.info('Invalidating caches');
        
        try {
            if (databases) {
                // Invalidation pour des bases de données spécifiques
                for (const dbId of databases) {
                    const startTime = Date.now();
                    await cacheInvalidationManager.invalidateDatabase(dbId);
                    
                    // Stockage des résultats avec durée d'exécution
                    this.results.cacheInvalidation[dbId] = {
                        status: 'success',
                        duration: Date.now() - startTime
                    };
                }
            } else {
                // Invalidation globale de toutes les bases de données
                const startTime = Date.now();
                await cacheInvalidationManager.invalidateAllDatabases();
                
                // Stockage du résultat global
                this.results.cacheInvalidation.all = {
                    status: 'success',
                    duration: Date.now() - startTime
                };
            }
        } catch (error) {
            // Gestion des erreurs d'invalidation avec logging
            logger.error('Cache invalidation failed', error);
            this.results.errors.push(`Cache invalidation failed: ${error.message}`);
        }
    }

    /**
     * Warm up critical caches
     */
    async warmUpCaches(databases) {
        logger.info('Warming up critical caches');
        
        // Utilisation des bases spécifiées ou toutes les bases configurées par défaut
        const databasesToWarm = databases || config.DATABASE_ROUTING.ALLOWED_DATABASES;
        
        // Réchauffement du cache pour chaque base de données
        for (const dbId of databasesToWarm) {
            try {
                const startTime = Date.now();
                
                // Création des loaders spécifiques à cette base de données
                const loaders = createLoaders(dbId);
                
                // Réchauffement du cache des métadonnées pour les champs les plus utilisés
                const metadataFields = ['country', 'indicator', 'date', 'value'];
                const metadataPromises = metadataFields.map(field => 
                    loaders.metadata.load(field).catch(err => 
                        logger.warn(`Failed to warm metadata for ${field}`, err)
                    )
                );
                
                // Réchauffement du cache des tables de dimensions principales
                const dimensionTables = ['country', 'indicator'];
                const dimensionPromises = dimensionTables.map(table => 
                    loaders.dimension.load(table).catch(err => 
                        logger.warn(`Failed to warm dimension for ${table}`, err)
                    )
                );
                
                // Exécution en parallèle de tous les réchauffements pour cette base
                await Promise.allSettled([...metadataPromises, ...dimensionPromises]);
                
                // Stockage des résultats du réchauffement
                this.results.cacheWarming[dbId] = {
                    status: 'success',
                    duration: Date.now() - startTime,
                    warmedItems: metadataFields.length + dimensionTables.length
                };
                
            } catch (error) {
                // Gestion des erreurs de réchauffement par base de données
                logger.error(`Cache warming failed for database ${dbId}`, error);
                this.results.cacheWarming[dbId] = {
                    status: 'failed',
                    error: error.message
                };
            }
        }
    }

    /**
     * Log final results
     */
    logResults() {
        const duration = Date.now() - this.startTime;
        const hasErrors = this.results.errors.length > 0;
        
        logger.info('Database update handling completed', {
            duration,
            hasErrors,
            results: this.results
        });
        
        if (hasErrors) {
            logger.error('Database update completed with errors', {
                errors: this.results.errors
            });
        }
    }

    /**
     * Get results for external processing
     */
    getResults() {
        return {
            ...this.results,
            duration: Date.now() - this.startTime,
            success: this.results.errors.length === 0
        };
    }
}

// CLI interface
async function main() {
    // Analyse des arguments de ligne de commande
    const args = process.argv.slice(2);
    const options = {
        databases: null,
        skipCacheInvalidation: args.includes('--skip-cache-invalidation'),
        skipCacheWarming: args.includes('--skip-cache-warming'),
        dryRun: args.includes('--dry-run')
    };

    // Analyse de la liste des bases de données si fournie
    const dbIndex = args.findIndex(arg => arg === '--databases');
    if (dbIndex >= 0 && args[dbIndex + 1]) {
        // Division de la liste séparée par virgules
        options.databases = args[dbIndex + 1].split(',');
    }

    const handler = new DatabaseUpdateHandler();
    
    try {
        await handler.handleUpdate(options);
        const results = handler.getResults();
        
        if (results.success) {
            console.log('✅ Database update handling completed successfully');
            process.exit(0);
        } else {
            console.error('❌ Database update handling completed with errors');
            console.error('Errors:', results.errors);
            process.exit(1);
        }
    } catch (error) {
        console.error('❌ Database update handling failed:', error.message);
        process.exit(1);
    }
}

// Export for programmatic use
export { DatabaseUpdateHandler };

// Run as CLI if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}