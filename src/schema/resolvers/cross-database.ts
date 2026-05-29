// Importation des modules
import { GraphQLError } from 'graphql';
import { withTimeout } from '../../utils/timeout.js';
import { databaseManager } from '../../db/index.js';
import { config } from '../../utils/config-loader.js';
import type { GraphQLContext } from './types.js';
import type {
  CompareFactsParams,
  CompareAggregatedFactsParams,
  CrossDatabaseSelectOptionsParams,
} from '../../loaders/cross-database.js';

// ─── Types d'agrégation ───────────────────────────────────────────────────────

/** Supported SQL aggregation operations for cross-catalog queries. */
export type AggregationType = 'SUM' | 'AVG' | 'MAX' | 'MIN' | 'COUNT' | 'MEDIAN' | 'MODE';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the compareFacts query. */
export interface CompareFactsArgs {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  joinFields: string[];
  limit?: number;
  offset?: number;
  sort?: Array<{ field: string; order: 'ASC' | 'DESC' }>;
}

/** Arguments for the compareAggregatedFacts query. */
export interface CompareAggregatedFactsArgs {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  groupBy: string;
  aggregation?: AggregationType;
  limit?: number;
  offset?: number;
}

/** Arguments for the crossDatabaseSelectOptions query. */
export interface CrossDatabaseSelectOptionsArgs {
  fieldName: string;
  catalogs: string[];
  schemas?: (string | null)[];
  limit?: number;
}

// ─── Constantes de validation ─────────────────────────────────────────────────

/** Exhaustive list of supported aggregation operations. */
const VALID_AGGREGATIONS: readonly AggregationType[] = [
  'SUM',
  'AVG',
  'MAX',
  'MIN',
  'COUNT',
  'MEDIAN',
  'MODE',
];

// ─── Fonction utilitaire ──────────────────────────────────────────────────────

/**
 * Checks that cross-catalog queries are enabled and throws if not.
 *
 * @throws {GraphQLError} When cross-catalog queries are disabled.
 */
// Vérification de l'activation des requêtes cross-catalog
function assertCrossDatabaseAllowed(): void {
  if (!databaseManager.isCrossCatalogAllowed()) {
    throw new GraphQLError(
      'Cross-catalog queries are disabled. Set ALLOW_CROSS_CATALOG_QUERIES=true to enable them.',
      { extensions: { code: 'CROSS_DATABASE_DISABLED' } },
    );
  }
}

/**
 * Validates a catalog alias and throws a descriptive error when invalid.
 *
 * @param catalog - Catalog alias to validate.
 * @throws {GraphQLError} When the alias is not registered in the database manager.
 */
// Validation d'un identifiant de catalogue
function assertValidCatalog(catalog: string): void {
  if (!databaseManager.isValidCatalog(catalog)) {
    throw new GraphQLError(`Catalog '${catalog}' is not available.`);
  }
}

// Resolver pour les requêtes cross-catalog
/**
 * Resolvers for cross-catalog / cross-schema query operations.
 *
 * All resolvers check that cross-catalog queries are enabled and that each
 * provided catalog alias is valid before dispatching to the loader. Comparing
 * two schemas of the same catalog (catalogA === catalogB, distinct schemas) is
 * supported and gated by the same flag.
 */
const crossDatabaseResolvers = {
  Query: {
    /**
     * Compares fact rows across two datasets joined on common fields.
     * Arguments follow {@link CompareFactsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Comparison result with rows from both datasets.
     * @throws {GraphQLError} When cross-catalog is disabled, catalogs are
     *     invalid, joinFields is empty, or limit exceeds the maximum.
     */
    // Comparaison des faits entre deux datasets
    compareFacts: async (
      _: unknown,
      {
        catalogA,
        catalogB,
        schemaA = null,
        schemaB = null,
        joinFields,
        limit = config.API.PAGINATION.DEFAULT_LIMIT,
        offset = 0,
        sort = [],
      }: CompareFactsArgs,
      { loaders }: GraphQLContext,
    ) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Validation des identifiants de catalogues
      [catalogA, catalogB].forEach(assertValidCatalog);

      // Vérification de la présence des champs de jointure
      if (!joinFields || joinFields.length === 0) {
        throw new GraphQLError('At least one joinField is required');
      }

      // Validation de la limite de pagination
      if (limit > config.API.PAGINATION.MAX_LIMIT) {
        throw new GraphQLError(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
      }

      return withTimeout(
        loaders.compareFacts.load({
          catalogA,
          catalogB,
          schemaA,
          schemaB,
          joinFields,
          limit,
          offset,
          sort,
        } as CompareFactsParams),
        config.API.TIMEOUTS.FACT_COMPLEX,
        'compareFacts timeout',
      );
    },

    /**
     * Compares aggregated facts across two datasets grouped by a dimension.
     * Arguments follow {@link CompareAggregatedFactsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Comparison result with aggregated rows from both datasets.
     * @throws {GraphQLError} When cross-catalog is disabled, catalogs or
     *     aggregation type are invalid, or groupBy is missing.
     */
    // Comparaison des faits agrégés entre deux datasets
    compareAggregatedFacts: async (
      _: unknown,
      {
        catalogA,
        catalogB,
        schemaA = null,
        schemaB = null,
        groupBy,
        aggregation = 'SUM',
        limit = config.API.PAGINATION.DEFAULT_LIMIT,
        offset = 0,
      }: CompareAggregatedFactsArgs,
      { loaders }: GraphQLContext,
    ) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Validation des identifiants de catalogues
      [catalogA, catalogB].forEach(assertValidCatalog);

      // Vérification de la présence du champ de regroupement
      if (!groupBy) {
        throw new GraphQLError('groupBy is required');
      }

      // Validation de la limite de pagination
      if (limit > config.API.PAGINATION.MAX_LIMIT) {
        throw new GraphQLError(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
      }

      // Validation du type d'agrégation
      if (!VALID_AGGREGATIONS.includes(aggregation)) {
        throw new GraphQLError(
          `Invalid aggregation. Must be one of: ${VALID_AGGREGATIONS.join(', ')}`,
        );
      }

      return withTimeout(
        loaders.compareAggregatedFacts.load({
          catalogA,
          catalogB,
          schemaA,
          schemaB,
          groupBy,
          aggregation,
          limit,
          offset,
        } as CompareAggregatedFactsParams),
        config.API.TIMEOUTS.AGGREGATED_SIMPLE,
        'compareAggregatedFacts timeout',
      );
    },

    /**
     * Fetches select options for a field across multiple datasets.
     * Arguments follow {@link CrossDatabaseSelectOptionsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Merged list of select options from all datasets.
     * @throws {GraphQLError} When cross-catalog is disabled, fewer than two
     *     catalogs are specified, or any alias is invalid.
     */
    // Récupération des options de sélection sur plusieurs datasets
    crossDatabaseSelectOptions: async (
      _: unknown,
      { fieldName, catalogs, schemas, limit = 50 }: CrossDatabaseSelectOptionsArgs,
      { loaders }: GraphQLContext,
    ) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Vérification de la présence d'au moins deux catalogues
      if (!catalogs || catalogs.length < 2) {
        throw new GraphQLError('At least two catalogs must be specified');
      }

      // Validation de chaque identifiant de catalogue
      catalogs.forEach(assertValidCatalog);

      return withTimeout(
        loaders.crossDatabaseSelectOptions.load({
          fieldName,
          catalogs,
          schemas: schemas ?? undefined,
          limit,
        } as CrossDatabaseSelectOptionsParams),
        config.API.TIMEOUTS.FACT_SIMPLE,
        'crossDatabaseSelectOptions timeout',
      );
    },
  },
};

export { crossDatabaseResolvers };
