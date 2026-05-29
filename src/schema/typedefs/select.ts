// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types pour les options de sélection ──────────────────────

/**
 * GraphQL type definitions for select option queries.
 *
 * Declares GroupedSelectOptions and the two query entry points:
 * getSelectOptions (flat list with optional search) and
 * getGroupedSelectOptions (two-level group/options structure).
 */
const selectTypeDefs: DocumentNode = gql`
  extend type Query {
    getSelectOptions(
      fieldName: String!
      limit: Int = 50
      searchTerm: String = ""
      catalog: String
      schema: String
    ): [SelectOption!]!

    getGroupedSelectOptions(
      groupField: String!
      optionsField: String!
      limit: Int = 50
      catalog: String
      schema: String
    ): GroupedSelectOptions!
  }

  type GroupedSelectOptions {
    group: [SelectOption!]!
    options: [SelectOption!]!
  }
`;

export { selectTypeDefs };
