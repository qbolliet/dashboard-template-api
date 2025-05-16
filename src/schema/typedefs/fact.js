// Importation des modules
import { gql } from 'apollo-server';


// Définition des types pour la requête des données
/**
 * GraphQL type definitions for fact data queries
 * Includes specialized types for D3 visualization format
 */
const factTypeDefs = gql`
    "A single fact record from the fact table"
    type Fact {
        value: Float
        dimensions: [String]
        dimensionLabels: [String]
    }

    "An aggregated fact record with key and value"
    type AggregatedFact {
        key: String
        aggregatedValue: Float
    }
    
    "Paginated response for fact queries"
    type PaginatedFacts {
        data: [Fact]
        total: Int
        hasNextPage: Boolean
        currentPage: Int
        totalPages: Int
    }
    
    "Metadata about a dataset, useful for visualization"
    type DatasetMetadata {
        count: Int!
        extents: JSON
        total: Int
        hasNextPage: Boolean
        currentPage: Int
        totalPages: Int
    }
    
    "D3-optimized data format with metadata"
    type DatasetWithMetadata {
        columns: [String!]!
        data: [JSON!]!
        metadata: DatasetMetadata!
    }
    
    "Custom scalar type for JSON objects"
    scalar JSON

    extend type Query {
        "Get fact table data with pagination and filtering"
        getFactTable(
            fields: [String!]
            filters: String
            structuredFilters: [Filter]
            limit: Int! = 100
            offset: Int! = 0
            sort: [SortInput!]
        ): PaginatedFacts
        
        "Get fact data optimized for D3 visualization"
        getFactTableWithMetadata(
            fields: [String!]
            filters: String
            structuredFilters: [Filter]
            limit: Int! = 100
            offset: Int! = 0
            sort: [SortInput!]
        ): DatasetWithMetadata
        
        "Get aggregated facts for charts and summaries"
        getAggregatedFacts(
            fields: [String!]!
            filters: String
            structuredFilters: [Filter]
            groupBy: String!
            aggregation: Aggregation!
            limit: Int! = 100
            offset: Int! = 0
            sort: [SortInput!]
        ): [AggregatedFact]
    }
`;

export { factTypeDefs };