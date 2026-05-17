// Importation de Winston et de son transport de rotation journalière
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from './config-loader.js';

// ─── Interfaces du logger contextuel ────────────────────────────────────────

/** Base context passed to every logging method. */
interface LogContext {
  requestId?: string;
  operationName?: string;
  duration?: number;
  cacheHit?: boolean;
  tags?: string[];
  [key: string]: unknown;
}

/** Interface for the enriched contextual logger returned by {@link createContextLogger}. */
interface ContextLogger {
  operation: (message: string, context?: LogContext) => void;
  database: (message: string, context?: LogContext) => void;
  cache: (message: string, context?: LogContext) => void;
  performance: (message: string, metrics?: Record<string, unknown>) => void;
  security: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, error: unknown, context?: LogContext) => void;
}

// ─── Fabrique de logger ──────────────────────────────────────────────────────

/**
 * Factory that creates and configures a Winston logger from application config.
 *
 * Handles transport setup (console, rotating files), log format (JSON or simple),
 * sampling in production, and automatic field sanitization.
 */
class LoggerFactory {
  private logConfig: typeof config.LOGGING;
  private environment: string;
  readonly logger: winston.Logger;

  // Lecture de la configuration de logging et création immédiate du logger
  constructor() {
    this.logConfig = config.LOGGING;
    this.environment = config.ENVIRONMENT;
    this.logger = this.createLogger();
  }

  /**
   * Instantiates a Winston logger with transports and format from config.
   *
   * @returns A configured winston.Logger instance.
   */
  // Création du logger Winston avec les transports et le format configurés
  private createLogger(): winston.Logger {
    const transports = this.createTransports();
    const format = this.createFormat();

    return winston.createLogger({
      level: this.logConfig.LEVEL,
      format,
      transports,
      // Prévention des crashs en cas d'erreur interne de logging
      exitOnError: false,
      handleExceptions: true,
      handleRejections: true,
    });
  }

  /**
   * Builds the combined Winston format pipeline.
   *
   * @returns A combined Winston format object.
   */
  // Construction du pipeline de formatage des logs
  private createFormat(): winston.Logform.Format {
    const formats: winston.Logform.Format[] = [
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
    ];

    // Ajout de l'échantillonnage en environnement de production
    if (this.shouldEnableSampling()) {
      formats.push(this.createSamplingFormat());
    }

    // Ajout de la sanitisation des champs sensibles
    formats.push(this.createSanitizationFormat());

    // Format structuré principal (JSON ou texte simple)
    formats.push(
      winston.format.printf((info) => {
        const base: Record<string, unknown> = {
          timestamp: info['timestamp'],
          level: info.level,
          service: 'graphql-api',
          environment: this.environment,
          requestId: info['requestId'],
          operationName: info['operationName'],
          duration: info['duration'],
          message: info.message,
        };

        // Ajout des métriques si présentes
        if (info['metrics']) {
          base['metrics'] = info['metrics'];
        }

        // Ajout du détail de l'erreur si présente
        if (info['error']) {
          const err = info['error'] as Error & { code?: string };
          base['error'] = {
            message: err.message ?? info['error'],
            code: err.code,
            // Stack trace uniquement en développement
            ...(this.environment === 'development' && { stack: err.stack }),
          };
        }

        // Tags pour le filtrage des logs
        base['tags'] = info['tags'] ?? this.inferTags(info as LogContext & { level: string });

        return this.logConfig.FORMAT === 'json'
          ? JSON.stringify(base)
          : `${base['timestamp']} [${base['level']}] ${base['message']}`;
      }),
    );

    return winston.format.combine(...formats);
  }

  /**
   * Creates the list of active Winston transports from config.
   *
   * @returns Array of configured transport instances.
   */
  // Création des transports actifs selon la configuration
  private createTransports(): winston.transport[] {
    const transports: winston.transport[] = [];

    // Transport console (sortie standard)
    if (this.logConfig.TRANSPORTS.console.enabled) {
      transports.push(
        new winston.transports.Console({
          format: this.logConfig.FORMAT === 'simple' ? winston.format.simple() : undefined,
        }),
      );
    }

    // Transport fichier rotatif principal
    if (this.logConfig.TRANSPORTS.file.enabled) {
      transports.push(
        new DailyRotateFile({
          filename: `${this.logConfig.TRANSPORTS.file.directory}/${this.logConfig.TRANSPORTS.file.filename}`,
          datePattern: this.logConfig.TRANSPORTS.file.datePattern,
          maxSize: this.logConfig.TRANSPORTS.file.maxSize,
          maxFiles: this.logConfig.TRANSPORTS.file.maxFiles,
          zippedArchive: this.logConfig.TRANSPORTS.file.compress,
        }),
      );
    }

    // Transport fichier dédié aux erreurs
    if (this.logConfig.TRANSPORTS.error.enabled) {
      transports.push(
        new DailyRotateFile({
          filename: `${this.logConfig.TRANSPORTS.error.directory}/${this.logConfig.TRANSPORTS.error.filename}`,
          level: 'error',
          datePattern: this.logConfig.TRANSPORTS.file.datePattern,
          maxSize: this.logConfig.TRANSPORTS.file.maxSize,
          maxFiles: this.logConfig.TRANSPORTS.file.maxFiles,
          zippedArchive: this.logConfig.TRANSPORTS.file.compress,
        }),
      );
    }

    return transports;
  }

  /**
   * Creates a Winston format that samples info/debug logs in production.
   *
   * Errors and warnings are always logged regardless of sampling rate.
   *
   * @returns A Winston format instance.
   */
  // Format d'échantillonnage — réduction du volume de logs en production
  private createSamplingFormat(): winston.Logform.Format {
    const samplingRate = this.logConfig.SAMPLING.rate;

    return winston.format((info) => {
      // Journalisation systématique des erreurs et avertissements
      if (info.level === 'error' || info.level === 'warn') {
        return info;
      }
      // Sélection aléatoire pour les autres niveaux
      if (Math.random() < samplingRate) {
        info['sampled'] = true;
        return info;
      }
      return false;
    })();
  }

  /**
   * Creates a Winston format that redacts sensitive fields from log entries.
   *
   * @returns A Winston format instance.
   */
  // Format de sanitisation — masquage des champs sensibles (mots de passe, tokens, etc.)
  private createSanitizationFormat(): winston.Logform.Format {
    const fieldsToSanitize = this.logConfig.SANITIZATION.fields;

    return winston.format((info) => {
      const sanitize = (obj: unknown): unknown => {
        if (typeof obj !== 'object' || obj === null) return obj;

        const sanitized: Record<string, unknown> = Array.isArray(obj)
          ? ([...(obj as unknown[])] as unknown as Record<string, unknown>)
          : { ...(obj as Record<string, unknown>) };

        Object.keys(sanitized).forEach((key) => {
          if (fieldsToSanitize.some((field) => key.toLowerCase().includes(field.toLowerCase()))) {
            sanitized[key] = '[REDACTED]';
          } else if (typeof sanitized[key] === 'object') {
            sanitized[key] = sanitize(sanitized[key]);
          }
        });

        return sanitized;
      };

      return sanitize(info) as winston.Logform.TransformableInfo;
    })();
  }

  /**
   * Determines whether log sampling should be active.
   *
   * Sampling is only enabled in production and when explicitly configured.
   *
   * @returns True when sampling should be applied.
   */
  // Activation de l'échantillonnage uniquement en production et si configuré
  private shouldEnableSampling(): boolean {
    return this.logConfig.SAMPLING.enabled && this.environment === 'production';
  }

  /**
   * Infers tags from log entry metadata for easier filtering.
   *
   * @param info - Log entry metadata object.
   * @returns Array of tag strings derived from the entry's properties.
   */
  // Inférence des tags à partir des métadonnées de l'entrée de log
  private inferTags(info: LogContext & { level: string }): string[] {
    const tags: string[] = [];

    if (info.operationName) tags.push('graphql');
    if (info['error']) tags.push('error');
    if ((info.duration ?? 0) > config.LOGGING.PERFORMANCE.SLOW_QUERY_THRESHOLD) {
      tags.push('slow-query');
    }
    if (info.cacheHit !== undefined) {
      tags.push(info.cacheHit ? 'cache-hit' : 'cache-miss');
    }

    return tags;
  }

  /**
   * Returns a context-bound logger with domain-specific methods.
   *
   * @param baseContext - Context fields automatically merged into every log entry.
   * @returns A {@link ContextLogger} with typed methods for each log domain.
   */
  // Création d'un logger contextuel avec des méthodes spécialisées par domaine
  createContextLogger(baseContext: LogContext = {}): ContextLogger {
    return {
      operation: (message, context = {}) => {
        this.logger.info(message, {
          ...baseContext,
          ...context,
          tags: ['operation', ...(context.tags ?? [])],
        });
      },

      database: (message, context = {}) => {
        this.logger.debug(message, {
          ...baseContext,
          ...context,
          tags: ['database', ...(context.tags ?? [])],
        });
      },

      cache: (message, context = {}) => {
        this.logger.debug(message, {
          ...baseContext,
          ...context,
          tags: ['cache', ...(context.tags ?? [])],
        });
      },

      performance: (message, metrics = {}) => {
        this.logger.info(message, {
          ...baseContext,
          metrics,
          tags: ['performance'],
        });
      },

      security: (message, context = {}) => {
        this.logger.warn(message, {
          ...baseContext,
          ...context,
          tags: ['security'],
        });
      },

      warn: (message, context = {}) => {
        this.logger.warn(message, {
          ...baseContext,
          ...context,
          tags: ['warning', ...(context.tags ?? [])],
        });
      },

      error: (message, error, context = {}) => {
        this.logger.error(message, {
          ...baseContext,
          ...context,
          error,
          tags: ['error', ...(context.tags ?? [])],
        });
      },
    };
  }
}

// Instanciation de la fabrique et exposition du logger principal
const loggerFactory = new LoggerFactory();
/** Shared Winston logger instance for the application. */
const logger = loggerFactory.logger;

/**
 * Creates a context-bound {@link ContextLogger} tied to a request or module context.
 *
 * @param context - Context fields merged into every log entry produced by the returned logger.
 * @returns A {@link ContextLogger} with domain-specific logging methods.
 */
// Fonction de création d'un logger contextuel lié à un contexte de requête
const createContextLogger = (context: LogContext): ContextLogger =>
  loggerFactory.createContextLogger(context);

export { logger, createContextLogger };
export type { ContextLogger, LogContext };
