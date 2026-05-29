// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types pour les données de faits ──────────────────────────

/**
 * GraphQL type definitions for fact table queries.
 *
 * Declares all types used by fact queries: Fact, Measure, DimensionDetail,
 * pagination wrappers (PaginatedFacts), D3-optimized dataset types
 * (DatasetWithMetadata, AggregatedFactsWithMetadata), the JSON scalar,
 * the DataFormat enum, and four Query entry points.
 */
const factTypeDefs: DocumentNode = gql`
  "Details about a dimension including its label"
  type DimensionDetail {
    "Name of the dimension"
    name: String!
    "Value of the dimension"
    value: String!
    "Human-readable label for the dimension value"
    label: String!
  }

  "A single measure of a fact row. The value preserves its original type (Float, Int, String…) via the JSON scalar."
  type Measure {
    "Name of the measure column (e.g. value, lower_bound, notes)"
    name: String!
    "Raw measure value, original type preserved"
    value: JSON
  }

  "A single fact record from the fact table"
  type Fact {
    "All measures of the row (every column with is_primary_key = false)"
    measures: [Measure!]!
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
    "ISO 8601 timestamp of when this query was executed"
    generatedAt: String!
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
    keyExtent: JSON # [min, max] pour clés numériques ou [first, last] pour strings
    valueExtent: [Float!]!
    statistics: AggregationStatistics
    groupByFieldInfo: Metadata
    "ISO 8601 timestamp of when this query was executed"
    generatedAt: String!
  }

  "Aggregated facts with D3-optimized metadata"
  type AggregatedFactsWithMetadata {
    data: [AggregatedFact!]!
    metadata: AggregatedFactsMetadata!
  }

  "Custom scalar type for JSON objects"
  scalar JSON

  "Format de sérialisation des données pour getFactTableWithMetadata"
  enum DataFormat {
    "Tableau d'objets [{col: val, ...}] — format par défaut, compatible D3 et DataTable"
    OBJECTS
    "Tableau de tableaux [[val1, val2, ...]] — plus compact, optimisé pour AG Grid / TanStack"
    ARRAYS
  }

  extend type Query {
    "Get fact table data with pagination and filtering"
    getFactTable(
      fields: [String!]
      filters: String
      structuredFilters: [Filter]
      limit: Int! = 100
      offset: Int! = 0
      sort: [SortInput!]
      catalog: String
      schema: String
    ): PaginatedFacts

    "Get fact data optimized for D3 visualization"
    getFactTableWithMetadata(
      fields: [String!]
      filters: String
      structuredFilters: [Filter]
      limit: Int! = 100
      offset: Int! = 0
      sort: [SortInput!]
      catalog: String
      schema: String
      "Format de sérialisation des données : OBJECTS (défaut) ou ARRAYS (tableau de tableaux)"
      format: DataFormat = OBJECTS
    ): DatasetWithMetadata

    "Get aggregated facts for charts and summaries"
    getAggregatedFacts(
      fields: [String!]
      filters: String
      structuredFilters: [Filter]
      groupBy: String!
      "Measure column to aggregate (e.g. value, lower_bound)"
      measure: String!
      aggregation: Aggregation! = SUM
      limit: Int! = 100
      offset: Int! = 0
      sort: [SortInput!]
      catalog: String
      schema: String
    ): [AggregatedFact]

    "Get aggregated facts with D3 metadata"
    getAggregatedFactsWithMetadata(
      fields: [String!]
      filters: String
      structuredFilters: [Filter]
      groupBy: String!
      "Measure column to aggregate (e.g. value, lower_bound)"
      measure: String!
      aggregation: Aggregation! = SUM
      limit: Int! = 100
      offset: Int! = 0
      sort: [SortInput!]
      catalog: String
      schema: String
    ): AggregatedFactsWithMetadata
  }
`;

export { factTypeDefs };
