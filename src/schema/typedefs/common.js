// Importation des modules
import { gql } from 'apollo-server';

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
      keyLabel: String
  }

  input Filter {
    key: String!
    operator: String!
    value: String
    values: [String!]
  }

  input SortInput {
    field: String!
    order: SortOrder = ASC
  }

  type SelectOption {
    value: String!
    label: String!
  }
`;

export { commonTypeDefs };