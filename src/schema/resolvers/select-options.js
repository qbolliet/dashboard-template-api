// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';

// Resolver pour la sélection des options
const selectOptionsResolvers = {
    Query: {
        getSelectOptions: async (_, { fieldName, limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT, searchTerm = "", database }, { loaders, getLoadersForDatabase }) => {
            const targetLoaders = getLoadersForDatabase(database);
            const loader = targetLoaders ? targetLoaders.selectOptions : loaders.selectOptions;
            return withTimeout(
                loader.load({ fieldName, limit, searchTerm }),
                config.API.TIMEOUTS.SELECT_OPTIONS,
                'Select options fetch timeout'
            );
        },

        getGroupedSelectOptions: async (_, { groupField, optionsField, limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT, database }, { loaders, getLoadersForDatabase }) => {
            const targetLoaders = getLoadersForDatabase(database);
            const loader = targetLoaders ? targetLoaders.selectOptions : loaders.selectOptions;
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