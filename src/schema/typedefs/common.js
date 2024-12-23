// Importation des modules
const { gql } = require('apollo-server');

// Définition des types communs à plusieurs resolvers
const commonTypeDefs = gql`
  enum SortOrder {
    ASC
    DESC
  }

  enum Aggregation {
    SUM
    AVG
    MAX
    MIN
    COUNT
    MEDIAN
    MODE
  }
  
  type AggregatedFact {
      key: String!
      aggregatedValue: Float!
      count: Int!
  }


  input Filter {
    key: String!
    operator: String!
    value: String!
  }

  input SortInput {
    field: String!
    order: SortOrder = ASC
  }

  type SelectOption {
    value: String!
    label: String!
  }

#   type PaginatedResponse {
#     total: Int!
#     hasNextPage: Boolean!
#   }
`;

module.exports = commonTypeDefs;