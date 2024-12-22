// Importation des modules
const { withTimeout } = require('../../utils/timeout');

// Resolver pour la sélection des options
const selectOptionsResolvers = {
    Query: {
        getSelectOptions: async (_, { fieldName, limit = 50, searchTerm = "" }, { loaders }) => {
            return withTimeout(
                loaders.selectOptions.load({ fieldName, limit, searchTerm }),
                5000,
                'Select options fetch timeout'
            );
        },

        getGroupedSelectOptions: async (_, { groupField, optionsField, limit = 50 }, { loaders }) => {
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

module.exports = selectOptionsResolvers;