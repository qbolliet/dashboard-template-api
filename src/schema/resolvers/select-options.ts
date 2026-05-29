// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import type { GraphQLContext } from './types.js';
import type { SelectOption } from '../../loaders/select-options.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getSelectOptions query. */
export interface SelectOptionsArgs {
  fieldName: string;
  limit?: number;
  searchTerm?: string;
  catalog?: string | null;
  schema?: string | null;
}

/** Arguments for the getGroupedSelectOptions query. */
export interface GroupedSelectOptionsArgs {
  groupField: string;
  optionsField: string;
  limit?: number;
  catalog?: string | null;
  schema?: string | null;
}

/** Grouped result of select options (group + options arrays). */
export interface GroupedSelectOptions {
  group: SelectOption[];
  options: SelectOption[];
}

// Resolver pour la sélection des options
/**
 * Resolvers for select options queries.
 *
 * Provides field values for dropdown menus and grouped option lists,
 * with optional full-text search filtering via searchTerm.
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
     * Fetches options for two fields simultaneously (group + options).
     * Loads both option sets in parallel to minimise latency.
     * Arguments follow {@link GroupedSelectOptionsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Object with group and options arrays.
     */
    getGroupedSelectOptions: async (
      _: unknown,
      {
        groupField,
        optionsField,
        limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT,
        catalog,
        schema,
      }: GroupedSelectOptionsArgs,
      { loaders, getLoadersForCatalog }: GraphQLContext,
    ): Promise<GroupedSelectOptions> => {
      // Sélection du loader adapté au catalogue/schéma cible
      const targetLoaders = getLoadersForCatalog(catalog, schema);
      const loader = targetLoaders ? targetLoaders.selectOptions : loaders.selectOptions;

      // Chargement en parallèle des deux ensembles d'options
      const [groupOptions, fieldOptions] = await Promise.all([
        loader.load({ fieldName: groupField, limit }),
        loader.load({ fieldName: optionsField, limit }),
      ]);

      return {
        group: groupOptions,
        options: fieldOptions,
      };
    },
  },
};

export { selectOptionsResolvers };
