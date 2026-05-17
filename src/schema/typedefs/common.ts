// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types communs ────────────────────────────────────────────

/**
 * GraphQL type definitions shared across multiple resolvers.
 *
 * Declares reusable enums (SortOrder, Aggregation), composite types
 * (AggregatedFact, SelectOption), and input types (Filter, SortInput)
 * consumed by fact, dimension, and catalog queries.
 */
const commonTypeDefs: DocumentNode = gql`
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
