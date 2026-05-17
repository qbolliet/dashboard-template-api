// Importation de GraphQLError pour le signalement des violations
import { GraphQLError } from 'graphql';
import { createContextLogger } from '../utils/logger.js';
import { config } from '../utils/config-loader.js';
import type { ContextLogger } from '../utils/logger.js';
import type { SecurityPatternEntry } from '../utils/config-loader.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** A blocked pattern compiled into a regular expression. */
interface CompiledPattern {
  regex: RegExp;
  message: string;
  original: string;
}

/** Raw set of patterns loaded from the configuration. */
interface PatternSet {
  blocked: SecurityPatternEntry[];
  allowed: string[];
}

/** Set of compiled patterns ready for validation. */
interface CompiledPatternSet {
  blocked: CompiledPattern[];
  allowed: string[];
}

// ─── Classe de validation des patterns ──────────────────────────────────────

/**
 * Validates GraphQL query strings against a configured set of blocked patterns.
 *
 * Patterns are loaded from the SECURITY_PATTERNS section of the YAML config
 * and compiled to regular expressions at construction time for performance.
 * Queries matching an allowed pattern bypass all blocked checks.
 */
class PatternValidator {
  private logger: ContextLogger;
  private patterns: PatternSet;
  private compiledPatterns: CompiledPatternSet;

  /**
   * Instantiates the validator and eagerly compiles all configured patterns.
   */
  constructor() {
    // Initialisation du logger contextuel
    this.logger = createContextLogger({ component: 'security', module: 'patterns' });
    // Chargement des patterns depuis la configuration YAML
    this.patterns = this.loadPatterns();
    // Compilation des patterns en expressions régulières
    this.compiledPatterns = this.compilePatterns();
  }

  /**
   * Loads security patterns from the application configuration.
   *
   * Falls back to sensible defaults when the SECURITY_PATTERNS section
   * is absent from the loaded configuration.
   *
   * @returns PatternSet with blocked and allowed pattern definitions.
   */
  private loadPatterns(): PatternSet {
    try {
      const env = process.env['NODE_ENV'] ?? 'development';

      // Vérification de la présence de la section SECURITY_PATTERNS
      if (!config.SECURITY_PATTERNS) {
        throw new Error('SECURITY_PATTERNS configuration not found');
      }

      // Fusion des listes bloquée et autorisée
      const patterns: PatternSet = {
        blocked: [...(config.SECURITY_PATTERNS.blocked ?? [])],
        allowed: [...(config.SECURITY_PATTERNS.allowed ?? [])],
      };

      // Journalisation du résultat du chargement
      this.logger.operation('Patterns loaded', {
        environment: env,
        blockedCount: patterns.blocked.length,
        allowedCount: patterns.allowed.length,
      });

      return patterns;
    } catch (error) {
      // Repli sur les patterns de sécurité minimaux en cas d'erreur
      this.logger.error('Failed to load security patterns', error);
      return {
        blocked: [
          { pattern: 'mutation', message: 'Mutations are not allowed', flags: 'i' },
          { pattern: 'drop\\s+table', message: 'DDL operations are forbidden', flags: 'i' },
        ],
        allowed: [],
      };
    }
  }

  /**
   * Compiles raw pattern definitions into regular expressions.
   *
   * Patterns that fail to compile are logged and skipped so a single
   * malformed entry does not disable the whole validator.
   *
   * @returns CompiledPatternSet with ready-to-use RegExp objects.
   */
  private compilePatterns(): CompiledPatternSet {
    const compiled: CompiledPatternSet = { blocked: [], allowed: [] };

    // Compilation des patterns bloqués en RegExp
    for (const entry of this.patterns.blocked) {
      try {
        compiled.blocked.push({
          regex: new RegExp(entry.pattern, entry.flags ?? 'i'),
          message: entry.message,
          original: entry.pattern,
        });
      } catch (error) {
        // Journalisation de l'échec sans interrompre les autres compilations
        this.logger.error('Failed to compile pattern', error, { pattern: entry.pattern });
      }
    }

    // Les patterns autorisés restent sous forme de chaînes
    compiled.allowed = this.patterns.allowed;

    return compiled;
  }

  /**
   * Validates a GraphQL query string against all configured patterns.
   *
   * A query matching an allowed pattern is unconditionally accepted.
   * Otherwise, each blocked pattern is tested and an error is thrown
   * on the first match.
   *
   * @param query - Raw GraphQL query string to validate.
   * @throws {GraphQLError} When a blocked pattern is detected in the query.
   */
  async validateQuery(query: string | null | undefined): Promise<void> {
    if (!query || typeof query !== 'string') {
      return;
    }

    // Vérification des patterns autorisés — court-circuit si trouvé
    for (const allowed of this.compiledPatterns.allowed) {
      if (query.includes(allowed)) {
        this.logger.operation('Query contains allowed pattern', {
          component: 'security',
          module: 'patterns',
          pattern: allowed,
        });
        return;
      }
    }

    // Longueur de l'extrait de requête pour les logs
    const snippetLength = config.API.SECURITY_THRESHOLDS?.QUERY_SNIPPET_LENGTH ?? 100;

    // Vérification des patterns bloqués
    for (const { regex, message, original } of this.compiledPatterns.blocked) {
      if (regex.test(query)) {
        // Journalisation de la violation détectée
        this.logger.security('Blocked pattern detected in query', {
          pattern: original,
          message,
          querySnippet: query.substring(0, snippetLength) + '...',
        });

        throw new GraphQLError(message, {
          extensions: {
            code: 'FORBIDDEN_PATTERN',
            pattern: original,
          },
        });
      }
    }
  }

  /**
   * Reloads and recompiles all patterns from the current configuration.
   *
   * Useful after a configuration hot-reload or in test scenarios.
   */
  reload(): void {
    // Rechargement et recompilation des patterns
    this.patterns = this.loadPatterns();
    this.compiledPatterns = this.compilePatterns();
    this.logger.operation('Pattern validator reloaded');
  }
}

export { PatternValidator };
export type { CompiledPattern, PatternSet, CompiledPatternSet };
