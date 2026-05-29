// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types de dimensions ──────────────────────────────────────

/**
 * GraphQL type definitions for dimension table queries.
 *
 * Declares the Dimension type (value/label pair) and the root Query
 * entry point for fetching a dimension table from a given catalog.
 */
const dimensionTypeDefs: DocumentNode = gql`
  type Dimension {
    value: String
    label: String
  }

  type Query {
    getDimensionTable(name: String!, catalog: String, schema: String): [Dimension]
  }
`;

export { dimensionTypeDefs };
