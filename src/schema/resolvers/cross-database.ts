// Importation des modules
import { GraphQLError } from 'graphql';
import { withTimeout } from '../../utils/timeout.js';
import { databaseManager } from '../../db/index.js';
import { config } from '../../utils/config-loader.js';
import type { GraphQLContext } from './types.js';
import type {
    CompareFactsParams,
    CompareAggregatedFactsParams,
    CrossDatabaseSelectOptionsParams
} from '../../loaders/cross-database.js';

// ─── Types d'agrégation ───────────────────────────────────────────────────────

/** Supported SQL aggregation operations for cross-database queries. */
type AggregationType = 'SUM' | 'AVG' | 'MAX' | 'MIN' | 'COUNT' | 'MEDIAN' | 'MODE';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the compareFacts query. */
export interface CompareFactsArgs {
    databaseA: string;
    databaseB: string;
    joinFields: string[];
    limit?: number;
    offset?: number;
    sort?: Array<{ field: string; order: 'ASC' | 'DESC' }>;
}

/** Arguments for the compareAggregatedFacts query. */
export interface CompareAggregatedFactsArgs {
    databaseA: string;
    databaseB: string;
    groupBy: string;
    aggregation?: AggregationType;
    limit?: number;
    offset?: number;
}

/** Arguments for the crossDatabaseSelectOptions query. */
export interface CrossDatabaseSelectOptionsArgs {
    fieldName: string;
    databases: string[];
    limit?: number;
}

// ─── Constantes de validation ─────────────────────────────────────────────────

/** Exhaustive list of supported aggregation operations. */
const VALID_AGGREGATIONS: readonly AggregationType[] = [
    'SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'MODE'
];

// ─── Fonction utilitaire ──────────────────────────────────────────────────────

/**
 * Checks that cross-database queries are enabled and throws if not.
 *
 * @throws {GraphQLError} When cross-database queries are disabled.
 */
// Vérification de l'activation des requêtes cross-base
function assertCrossDatabaseAllowed(): void {
    if (!databaseManager.isCrossDatabaseAllowed()) {
        throw new GraphQLError(
            'Cross-database queries are disabled. Set ALLOW_CROSS_DATABASE_QUERIES=true to enable them.',
            { extensions: { code: 'CROSS_DATABASE_DISABLED' } }
        );
    }
}

/**
 * Validates a database alias and throws a descriptive error when invalid.
 *
 * @param db - Database alias to validate.
 * @throws {GraphQLError} When the alias is not registered in the database manager.
 */
// Validation d'un identifiant de base de données
function assertValidDatabase(db: string): void {
    if (!databaseManager.isValidDatabase(db)) {
        throw new GraphQLError(`Database '${db}' is not available.`);
    }
}

// Resolver pour les requêtes cross-base
/**
 * Resolvers for cross-database query operations.
 *
 * All resolvers check that cross-database queries are enabled and that
 * each provided database alias is valid before dispatching to the loader.
 */
const crossDatabaseResolvers = {
    Query: {
        /**
         * Compares fact rows across two databases joined on common fields.
         *
         * @param _ - Parent resolver result (unused at root).
         * @param databaseA - Alias of the first database.
         * @param databaseB - Alias of the second database.
         * @param joinFields - Field names used to join the two datasets.
         * @param limit - Maximum number of rows to return.
         * @param offset - Number of rows to skip.
         * @param sort - Sort criteria applied after the join.
         * @param context - GraphQL context with loaders.
         * @returns Comparison result with rows from both databases.
         * @throws {GraphQLError} When cross-database is disabled, databases are
         *     invalid, joinFields is empty, or limit exceeds the maximum.
         */
        // Comparaison des faits entre deux bases de données
        compareFacts: async (
            _: unknown,
            {
                databaseA,
                databaseB,
                joinFields,
                limit = config.API.PAGINATION.DEFAULT_LIMIT,
                offset = 0,
                sort = []
            }: CompareFactsArgs,
            { loaders }: GraphQLContext
        ) => {
            // Vérification de l'activation des requêtes cross-base
            assertCrossDatabaseAllowed();

            // Validation des identifiants de bases de données
            [databaseA, databaseB].forEach(assertValidDatabase);

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
                    databaseA, databaseB, joinFields, limit, offset, sort
                } as CompareFactsParams),
                config.API.TIMEOUTS.FACT_COMPLEX,
                'compareFacts timeout'
            );
        },

        /**
         * Compares aggregated facts across two databases grouped by a dimension.
         *
         * @param _ - Parent resolver result (unused at root).
         * @param databaseA - Alias of the first database.
         * @param databaseB - Alias of the second database.
         * @param groupBy - Dimension field used for grouping.
         * @param aggregation - Aggregation function to apply.
         * @param limit - Maximum number of groups to return.
         * @param offset - Number of groups to skip.
         * @param context - GraphQL context with loaders.
         * @returns Comparison result with aggregated rows from both databases.
         * @throws {GraphQLError} When cross-database is disabled, databases or
         *     aggregation type are invalid, or groupBy is missing.
         */
        // Comparaison des faits agrégés entre deux bases de données
        compareAggregatedFacts: async (
            _: unknown,
            {
                databaseA,
                databaseB,
                groupBy,
                aggregation = 'SUM',
                limit = config.API.PAGINATION.DEFAULT_LIMIT,
                offset = 0
            }: CompareAggregatedFactsArgs,
            { loaders }: GraphQLContext
        ) => {
            // Vérification de l'activation des requêtes cross-base
            assertCrossDatabaseAllowed();

            // Validation des identifiants de bases de données
            [databaseA, databaseB].forEach(assertValidDatabase);

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
                    `Invalid aggregation. Must be one of: ${VALID_AGGREGATIONS.join(', ')}`
                );
            }

            return withTimeout(
                loaders.compareAggregatedFacts.load({
                    databaseA, databaseB, groupBy, aggregation, limit, offset
                } as CompareAggregatedFactsParams),
                config.API.TIMEOUTS.AGGREGATED_SIMPLE,
                'compareAggregatedFacts timeout'
            );
        },

        /**
         * Fetches select options for a field across multiple databases.
         *
         * @param _ - Parent resolver result (unused at root).
         * @param fieldName - Field to fetch options for.
         * @param databases - List of database aliases to query.
         * @param limit - Maximum number of options to return.
         * @param context - GraphQL context with loaders.
         * @returns Merged list of select options from all databases.
         * @throws {GraphQLError} When cross-database is disabled, fewer than two
         *     databases are specified, or any alias is invalid.
         */
        // Récupération des options de sélection sur plusieurs bases de données
        crossDatabaseSelectOptions: async (
            _: unknown,
            {
                fieldName,
                databases,
                limit = 50
            }: CrossDatabaseSelectOptionsArgs,
            { loaders }: GraphQLContext
        ) => {
            // Vérification de l'activation des requêtes cross-base
            assertCrossDatabaseAllowed();

            // Vérification de la présence d'au moins deux bases de données
            if (!databases || databases.length < 2) {
                throw new GraphQLError('At least two databases must be specified');
            }

            // Validation de chaque identifiant de base de données
            databases.forEach(assertValidDatabase);

            return withTimeout(
                loaders.crossDatabaseSelectOptions.load({
                    fieldName, databases, limit
                } as CrossDatabaseSelectOptionsParams),
                config.API.TIMEOUTS.FACT_SIMPLE,
                'crossDatabaseSelectOptions timeout'
            );
        }
    }
};

export { crossDatabaseResolvers };
