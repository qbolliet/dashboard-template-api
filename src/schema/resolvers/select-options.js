// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';

// Resolver pour la sélection des options
const selectOptionsResolvers = {
    Query: {
        getSelectOptions: async (_, { fieldName, limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT, searchTerm = "" }, { loaders }) => {
            return withTimeout(
                loaders.selectOptions.load({ fieldName, limit, searchTerm }),
                config.API.TIMEOUTS.SELECT_OPTIONS,
                'Select options fetch timeout'
            );
        },

        getGroupedSelectOptions: async (_, { groupField, optionsField, limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT }, { loaders }) => {
            const [groupOptions, fieldOptions] = await Promise.all([
                loaders.selectOptions.load({ fieldName: groupField, limit }),
                loaders.selectOptions.load({ fieldName: optionsField, limit })
            ]);

            return {
                group: groupOptions,
                options: fieldOptions
            };
        }
    }
};

export { selectOptionsResolvers };