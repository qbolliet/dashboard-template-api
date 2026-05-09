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
    database?: string | null;
}

/** Arguments for the getGroupedSelectOptions query. */
export interface GroupedSelectOptionsArgs {
    groupField: string;
    optionsField: string;
    limit?: number;
    database?: string | null;
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
         *
         * @param _ - Parent resolver result (unused at root).
         * @param fieldName - Name of the field to fetch options for.
         * @param limit - Maximum number of options to return.
         * @param searchTerm - Optional text filter applied server-side.
         * @param database - Optional database alias override.
         * @param context - GraphQL context with loaders.
         * @returns Array of select option objects.
         */
        getSelectOptions: async (
            _: unknown,
            {
                fieldName,
                limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT,
                searchTerm = '',
                database
            }: SelectOptionsArgs,
            { loaders, getLoadersForDatabase }: GraphQLContext
        ) => {
            // Sélection du loader adapté à la base de données cible
            const targetLoaders = getLoadersForDatabase(database);
            const loader = targetLoaders ? targetLoaders.selectOptions : loaders.selectOptions;

            return withTimeout(
                loader.load({ fieldName, limit, searchTerm }),
                config.API.TIMEOUTS.SELECT_OPTIONS,
                'Select options fetch timeout'
            );
        },

        /**
         * Fetches options for two fields simultaneously (group + options).
         *
         * Loads both option sets in parallel to minimise latency, then
         * returns them as a structured object.
         *
         * @param _ - Parent resolver result (unused at root).
         * @param groupField - Field used as the grouping dimension.
         * @param optionsField - Field whose options are listed inside each group.
         * @param limit - Maximum number of options to return for each field.
         * @param database - Optional database alias override.
         * @param context - GraphQL context with loaders.
         * @returns Object with group and options arrays.
         */
        getGroupedSelectOptions: async (
            _: unknown,
            {
                groupField,
                optionsField,
                limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT,
                database
            }: GroupedSelectOptionsArgs,
            { loaders, getLoadersForDatabase }: GraphQLContext
        ): Promise<GroupedSelectOptions> => {
            // Sélection du loader adapté à la base de données cible
            const targetLoaders = getLoadersForDatabase(database);
            const loader = targetLoaders ? targetLoaders.selectOptions : loaders.selectOptions;

            // Chargement en parallèle des deux ensembles d'options
            const [groupOptions, fieldOptions] = await Promise.all([
                loader.load({ fieldName: groupField, limit }),
                loader.load({ fieldName: optionsField, limit })
            ]);

            return {
                group: groupOptions,
                options: fieldOptions
            };
        }
    }
};

export { selectOptionsResolvers };
