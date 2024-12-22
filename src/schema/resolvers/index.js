const resolvers = {
    Query: {
        ...metadataResolvers.Query,
        ...dimensionResolvers.Query,
        ...factResolvers.Query,
        ...aggregatedFactsResolvers.Query
        ...selectOptionsResolvers.Query
    }
};

module.exports = {
    resolvers,
    metadataResolvers,
    dimensionResolvers,
    factResolvers,
    aggregatedFactsResolvers,
    selectOptionsResolvers
};