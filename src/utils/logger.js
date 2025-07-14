// Importation des modules
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from './config-loader.js';

// Classe de création d'un logger
class LoggerFactory {
    // Initialisation
    constructor() {
        this.logConfig = config.LOGGING;
        this.environment = config.ENVIRONMENT;
        this.logger = this.createLogger();
    }

    // Méthode de création du logger
    createLogger() {
      // Création des transports et du format
        const transports = this.createTransports();
        const format = this.createFormat();

        return winston.createLogger({
            level: this.logConfig.LEVEL,
            format,
            transports,
            // Évite les crashs en cas d'erreur de logging
            exitOnError: false,
            // Rejete les logs si le buffer est plein
            handleExceptions: true,
            handleRejections: true
        });
    }

    // Méthode de création du format
    createFormat() {
        // Initialisation du format
        const formats = [
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss.SSS'
            }),
            winston.format.errors({ stack: true })
        ];

        // Ajout du sampling en production
        if (this.shouldEnableSampling()) {
            formats.push(this.createSamplingFormat());
        }

        // Format de sanitization
        formats.push(this.createSanitizationFormat());

        // Format de base enrichi
        formats.push(winston.format.printf(info => {
            const base = {
                timestamp: info.timestamp,
                level: info.level,
                service: 'graphql-api',
                environment: this.environment,
                requestId: info.requestId,
                operationName: info.operationName,
                duration: info.duration,
                message: info.message
            };

            // Ajout des métriques si présentes
            if (info.metrics) {
                base.metrics = info.metrics;
            }

            // Ajout de l'erreur si présente
            if (info.error) {
                base.error = {
                    message: info.error.message || info.error,
                    code: info.error.code,
                    // Stack trace seulement en dev
                    ...(this.environment === 'development' && {
                        stack: info.error.stack
                    })
                };
            }

            // Tags pour faciliter le filtrage
            base.tags = info.tags || this.inferTags(info);

            return this.logConfig.FORMAT === 'json'
                ? JSON.stringify(base)
                : `${base.timestamp} [${base.level}] ${base.message}`;
        }));

        return winston.format.combine(...formats);
    }

    // Méthode de création des transports
    createTransports() {
        // Initialisation
        const transports = [];

        // Console
        if (this.logConfig.TRANSPORTS.console.enabled) {
            transports.push(new winston.transports.Console({
                format: this.logConfig.FORMAT === 'simple'
                    ? winston.format.simple()
                    : undefined
            }));
        }

        // Fichiers rotatifs
        if (this.logConfig.TRANSPORTS.file.enabled) {
            transports.push(new DailyRotateFile({
                filename: `${this.logConfig.TRANSPORTS.file.directory}/${this.logConfig.TRANSPORTS.file.filename}`,
                datePattern: this.logConfig.TRANSPORTS.file.datePattern,
                maxSize: this.logConfig.TRANSPORTS.file.maxSize,
                maxFiles: this.logConfig.TRANSPORTS.file.maxFiles,
                zippedArchive: this.logConfig.TRANSPORTS.file.compress
            }));
        }

        // Fichier d'erreurs séparé
        if (this.logConfig.TRANSPORTS.error.enabled) {
            transports.push(new DailyRotateFile({
                filename: `${this.logConfig.TRANSPORTS.error.directory}/${this.logConfig.TRANSPORTS.error.filename}`,
                level: 'error',
                datePattern: this.logConfig.TRANSPORTS.file.datePattern,
                maxSize: this.logConfig.TRANSPORTS.file.maxSize,
                maxFiles: this.logConfig.TRANSPORTS.file.maxFiles,
                zippedArchive: this.logConfig.TRANSPORTS.file.compress
            }));
        }

        return transports;
    }

    // Méthode de création du format d'échantillonnage
    createSamplingFormat() {
        const samplingRate = this.logConfig.SAMPLING.rate;
        
        return winston.format((info) => {
            // Toujours logger les erreurs et warnings
            if (info.level === 'error' || info.level === 'warn') {
                return info;
            }
            
            // Échantillonnage pour les autres niveaux
            if (Math.random() < samplingRate) {
                info.sampled = true;
                return info;
            }
            
            return false; // Ne pas logger
        })();
    }

    // Méthode de création d'un format propre
    createSanitizationFormat() {
        const fieldsToSanitize = this.logConfig.SANITIZATION.fields;
        
        return winston.format((info) => {
            const sanitize = (obj) => {
                if (typeof obj !== 'object' || obj === null) return obj;
                
                const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };
                
                Object.keys(sanitized).forEach(key => {
                    if (fieldsToSanitize.some(field => 
                        key.toLowerCase().includes(field.toLowerCase())
                    )) {
                        sanitized[key] = '[REDACTED]';
                    } else if (typeof sanitized[key] === 'object') {
                        sanitized[key] = sanitize(sanitized[key]);
                    }
                });
                
                return sanitized;
            };
            
            return sanitize(info);
        })();
    }

    // Méthode de définition des cas d'utilisation de l'échantillonnage (en production et quand spécifié par l'utilisateur)
    shouldEnableSampling() {
        return this.logConfig.SAMPLING.enabled && this.environment === 'production';
    }

    // Méthode d'association de tags aux informations
    inferTags(info) {
        const tags = [];
        
        if (info.operationName) tags.push('graphql');
        if (info.error) tags.push('error');
        if (info.duration > config.LOGGING.PERFORMANCE.SLOW_QUERY_THRESHOLD) tags.push('slow-query');
        if (info.cacheHit !== undefined) tags.push(info.cacheHit ? 'cache-hit' : 'cache-miss');
        
        return tags;
    }

    // Méthode auxiliaire pour définir des logs structurés
    createContextLogger(baseContext = {}) {
        return {
            operation: (message, context = {}) => {
                this.logger.info(message, {
                    ...baseContext,
                    ...context,
                    tags: ['operation', ...(context.tags || [])]
                });
            },
            
            database: (message, context = {}) => {
                this.logger.debug(message, {
                    ...baseContext,
                    ...context,
                    tags: ['database', ...(context.tags || [])]
                });
            },
            
            cache: (message, context = {}) => {
                this.logger.debug(message, {
                    ...baseContext,
                    ...context,
                    tags: ['cache', ...(context.tags || [])]
                });
            },
            
            performance: (message, metrics = {}) => {
                this.logger.info(message, {
                    ...baseContext,
                    metrics,
                    tags: ['performance']
                });
            },
            
            security: (message, context = {}) => {
                this.logger.warn(message, {
                    ...baseContext,
                    ...context,
                    tags: ['security']
                });
            },
            
            error: (message, error, context = {}) => {
                this.logger.error(message, {
                    ...baseContext,
                    ...context,
                    error,
                    tags: ['error', ...(context.tags || [])]
                });
            }
        };
    }
}

// Initialisation du logger
const loggerFactory = new LoggerFactory();
const logger = loggerFactory.logger;

// Fonction de création d'un logger contextuel
const createContextLogger = (context) => loggerFactory.createContextLogger(context);

export { logger, createContextLogger };