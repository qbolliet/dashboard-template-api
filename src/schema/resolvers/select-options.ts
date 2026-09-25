// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import { DEFAULT_TREE_MAX_NODES } from '../../loaders/select-options.js';
import type { GraphQLContext } from './types.js';
import type { SelectOptionNode } from '../../loaders/select-options.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getSelectOptions query. */
export interface SelectOptionsArgs {
  fieldName: string;
  limit?: number;
  searchTerm?: string;
  catalog?: string | null;
  schema?: string | null;
}

/** Arguments for the getSelectOptionsTree query. */
export interface SelectOptionsTreeArgs {
  fieldName: string;
  maxDepth?: number | null;
  searchTerm?: string | null;
  catalog?: string | null;
  schema?: string | null;
}

// Resolver pour la sélection des options
/**
 * Resolvers for select options queries.
 *
 * Provides field values for dropdown menus (flat list of one column) and
 * nested option trees of column hierarchies, both with optional
 * case-insensitive search via searchTerm.
 */
const selectOptionsResolvers = {
  Query: {
    /**
     * Fetches available options for a single field.
     * Arguments follow {@link SelectOptionsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Array of select option objects.
     */
    getSelectOptions: async (
      _: unknown,
      {
        fieldName,
        limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT,
        searchTerm = '',
        catalog,
        schema,
      }: SelectOptionsArgs,
      { loaders, getLoadersForCatalog }: GraphQLContext,
    ) => {
      // Sélection du loader adapté au catalogue/schéma cible
      const targetLoaders = getLoadersForCatalog(catalog, schema);
      const loader = targetLoaders ? targetLoaders.selectOptions : loaders.selectOptions;

      return withTimeout(
        loader.load({ fieldName, limit, searchTerm }),
        config.API.TIMEOUTS.SELECT_OPTIONS,
        'Select options fetch timeout',
      );
    },

    /**
     * Fetches the nested option tree of a column hierarchy.
     * Arguments follow {@link SelectOptionsTreeArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Forest of `{ value, label, children? }` nodes.
     */
    getSelectOptionsTree: async (
      _: unknown,
      { fieldName, maxDepth = null, searchTerm = null, catalog, schema }: SelectOptionsTreeArgs,
      { loaders, getLoadersForCatalog }: GraphQLContext,
    ): Promise<SelectOptionNode[]> => {
      // Sélection du loader adapté au catalogue/schéma cible
      const targetLoaders = getLoadersForCatalog(catalog, schema);
      const loader = targetLoaders ? targetLoaders.selectOptionsTree : loaders.selectOptionsTree;

      // La borne fait partie de la clé : un arbre en cache ne la contourne jamais
      const maxNodes = config.API.SELECT_OPTIONS?.TREE_MAX_NODES ?? DEFAULT_TREE_MAX_NODES;

      return withTimeout(
        loader.load({ fieldName, maxDepth, searchTerm: searchTerm || null, maxNodes }),
        config.API.TIMEOUTS.SELECT_OPTIONS,
        'Select options tree fetch timeout',
      );
    },
  },
};

export { selectOptionsResolvers };
