// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import type { GraphQLContext } from './types.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getDimensionTable query. */
export interface DimensionTableArgs {
    name: string;
    database?: string | null;
}

// Construction d'un resolver pour les dimensions
/**
 * Resolvers for dimension table queries.
 *
 * Uses the dimension loader for consistency with the architecture.
 * Supports optional database routing via the getLoadersForDatabase helper.
 */
const dimensionResolvers = {
    Query: {
        /**
         * Gets all records from a dimension table.
         *
         * @param _ - Parent resolver result (unused at root).
         * @param name - Name of the dimension table to load.
         * @param database - Optional database alias override.
         * @param context - GraphQL context with loaders.
         * @returns Array of dimension records from the requested table.
         */
        getDimensionTable: async (
            _: unknown,
            { name, database }: DimensionTableArgs,
            { loaders, getLoadersForDatabase }: GraphQLContext
        ) => {
            // Sélection du loader adapté à la base de données cible
            const targetLoaders = getLoadersForDatabase(database);
            const loader = targetLoaders ? targetLoaders.dimension : loaders.dimension;

            // Utilisation du loader au lieu d'un accès direct à la base
            return withTimeout(
                loader.load(name),
                config.API.TIMEOUTS.DIMENSION,
                'Dimension table fetch timeout'
            );
        }
    }
};

export { dimensionResolvers };
