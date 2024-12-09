// Importation des modules
const { gql } = require('apollo-server');


// Define the GraphQL schema
const typeDefs = gql`
  type Metadata {
    name: String
    label: String
    python_type: String
    sql_type: String
    is_categorical: Boolean
  }

  type Dimension {
    value: Int
    label: String
  }

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

  input Filter {
    key: String
    operator: String
    value: String
  }

  enum Aggregation {
    SUM
    AVG
    MAX
    MIN
    COUNT
  }

  type Query {
    getMetaData(name: String!): Metadata
    getDimensionTable(name: String!): [Dimension]
    getFactTable(
      indicator: String
      filters: String
      structuredFilters: [Filter]
      limit: Int!
      offset: Int!
    ): PaginatedFacts
    getAggregatedFacts(
      indicator: String!
      filters: String
      structuredFilters: [Filter]
      groupBy: String!
      aggregation: Aggregation!
    ): [AggregatedFact]
  }
`;

exports.typeDefs = typeDefs