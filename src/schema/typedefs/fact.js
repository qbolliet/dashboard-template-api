// Importation des modules
import { gql } from 'apollo-server';

// Définition des types pour la requête des données
/**
 * GraphQL type definitions for fact data queries
 * Includes specialized types for D3 visualization format
 */
const factTypeDefs = gql`
    "Details about a dimension including its label"
    type DimensionDetail {
        "Name of the dimension"
        name: String!
        "Value of the dimension"
        value: String!
        "Human-readable label for the dimension value"
        label: String!
    }

    "A single fact record from the fact table"
    type Fact {
        "Numeric value of the fact"
        value: Float
        "Detailed dimension information including labels"
        dimensionDetails: [DimensionDetail]
    }

    "An aggregated fact record with key and value"
    type AggregatedFact {
        "Grouping key"
        key: String
        "Aggregated value"
        aggregatedValue: Float
        "Number of records in this group"
        count: Int
    }
    
    "Paginated response for fact queries"
    type PaginatedFacts {
        "Array of fact records"
        data: [Fact]
        "Total number of records matching the query"
        total: Int
        "Whether there are more pages available"
        hasNextPage: Boolean
        "Current page number (1-indexed)"
        currentPage: Int
        "Total number of pages"
        totalPages: Int
    }
    
    "Metadata about a dataset, useful for visualization"
    type DatasetMetadata {
        "Number of records in current page"
        count: Int!
        "Min/max values for numeric columns"
        extents: JSON
        "Total number of records matching the query"
        total: Int
        "Whether there are more pages available"
        hasNextPage: Boolean
        "Current page number (1-indexed)"
        currentPage: Int
        "Total number of pages"
        totalPages: Int
    }
    
    "D3-optimized data format with metadata"
    type DatasetWithMetadata {
        "Column names in the dataset"
        columns: [String!]!
        "Raw data as JSON objects"
        data: [JSON!]!
        "Metadata about the dataset"
        metadata: DatasetMetadata!
    }

    "Statistics for aggregated data"
    type AggregationStatistics {
        mean: Float
        median: Float
        stdDev: Float
        quartiles: [Float]
    }
    
    "Metadata for aggregated facts optimized for D3"
    type AggregatedFactsMetadata {
        count: Int!
        keyExtent: JSON  # [min, max] pour clés numériques ou [first, last] pour strings
        valueExtent: [Float!]!
        statistics: AggregationStatistics
        groupByFieldInfo: Metadata
    }
    
    "Aggregated facts with D3-optimized metadata"
    type AggregatedFactsWithMetadata {
        data: [AggregatedFact!]!
        metadata: AggregatedFactsMetadata!
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
            fields: [String!]
            filters: String
            structuredFilters: [Filter]
            groupBy: String!
            aggregation: Aggregation! = SUM
            limit: Int! = 100
            offset: Int! = 0
            sort: [SortInput!]
        ): [AggregatedFact]

        "Get aggregated facts with D3 metadata"
        getAggregatedFactsWithMetadata(
            fields: [String!]
            filters: String
            structuredFilters: [Filter]
            groupBy: String!
            aggregation: Aggregation! = SUM
            limit: Int! = 100
            offset: Int! = 0
            sort: [SortInput!]
        ): AggregatedFactsWithMetadata
    }
`;

export { factTypeDefs };