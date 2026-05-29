// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import type { GraphQLContext } from './types.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getDimensionTable query. */
export interface DimensionTableArgs {
  name: string;
  catalog?: string | null;
  schema?: string | null;
}

// Construction d'un resolver pour les dimensions
/**
 * Resolvers for dimension table queries.
 *
 * Uses the dimension loader for consistency with the architecture.
 * Supports optional catalog/schema routing via the getLoadersForCatalog helper.
 */
const dimensionResolvers = {
  Query: {
    /**
     * Gets all records from a dimension table.
     * Arguments follow {@link DimensionTableArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Array of dimension records from the requested table.
     */
    getDimensionTable: async (
      _: unknown,
      { name, catalog, schema }: DimensionTableArgs,
      { loaders, getLoadersForCatalog }: GraphQLContext,
    ) => {
      // Sélection du loader adapté au catalogue/schéma cible
      const targetLoaders = getLoadersForCatalog(catalog, schema);
      const loader = targetLoaders ? targetLoaders.dimension : loaders.dimension;

      // Utilisation du loader au lieu d'un accès direct à la base
      return withTimeout(
        loader.load(name),
        config.API.TIMEOUTS.DIMENSION,
        'Dimension table fetch timeout',
      );
    },
  },
};

export { dimensionResolvers };
