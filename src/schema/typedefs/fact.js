// Importation des modules
const { gql } = require('apollo-server');

// Définition des types pour la requête des données
const factTypeDefs = gql`
    type Fact {
        value: Float
        dimensions: [String]
        dimensionLabels: [String]
    }

    type AggregatedFact {
        key: String
        aggregatedValue: Float
    }
    
    type PaginatedFacts {
        data: [Fact]
        total: Int
        hasNextPage: Boolean
    }

    type Query {
        getFactTable(
            indicators: String
            filters: String
            structuredFilters: [Filter]
            limit: Int!
            offset: Int!
            sort: [SortInput!]
        ): PaginatedFacts
        getAggregatedFacts(
            indicators: String!
            filters: String
            structuredFilters: [Filter]
            groupBy: String!
            aggregation: Aggregation!
            sort: [SortInput!]
        ): [AggregatedFact]
    }
`;

exports.factTypeDefs = factTypeDefs