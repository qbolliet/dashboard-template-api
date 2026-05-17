// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types pour les comparaisons cross-catalogue ───────────────

/**
 * GraphQL type definitions for cross-database comparison queries.
 *
 * Declares ComparedFact (single comparison row with delta values),
 * PaginatedComparedFacts (paginated result set), and three Query entry
 * points for comparing raw facts, aggregated facts, and select options
 * across two catalogs.
 */
const crossDatabaseTypeDefs: DocumentNode = gql`
  "Comparaison d'une valeur entre deux catalogues sur une clé commune"
  type ComparedFact {
    "Valeur de la clé commune (dimension de jointure)"
    key: String!
    "Label lisible de la clé (si dimension catégorielle)"
    keyLabel: String
    "Valeur dans le catalogue A"
    valueA: Float
    "Valeur dans le catalogue B"
    valueB: Float
    "Différence absolue (valueB - valueA)"
    delta: Float
    "Différence relative en % ((valueB - valueA) / valueA * 100)"
    deltaPercent: Float
  }

  "Résultat paginé pour les comparaisons cross-database"
  type PaginatedComparedFacts {
    data: [ComparedFact!]!
    total: Int!
    hasNextPage: Boolean!
    currentPage: Int!
    totalPages: Int!
  }

  extend type Query {
    "Compare les faits de deux catalogues sur des champs de jointure communs"
    compareFacts(
      "Premier catalogue (référence)"
      databaseA: String!
      "Second catalogue (comparaison)"
      databaseB: String!
      "Champs utilisés pour la jointure (doivent exister dans les deux catalogues)"
      joinFields: [String!]!
      limit: Int! = 100
      offset: Int! = 0
      sort: [SortInput!]
    ): PaginatedComparedFacts!

    "Compare les faits agrégés de deux catalogues sur un groupBy commun"
    compareAggregatedFacts(
      databaseA: String!
      databaseB: String!
      "Champ de regroupement commun aux deux catalogues"
      groupBy: String!
      aggregation: Aggregation! = SUM
      limit: Int! = 100
      offset: Int! = 0
    ): PaginatedComparedFacts!

    "Retourne les options de sélection communes à plusieurs catalogues"
    crossDatabaseSelectOptions(
      "Nom du champ à intersecter"
      fieldName: String!
      "Liste des catalogues à croiser (minimum 2)"
      databases: [String!]!
      limit: Int! = 50
    ): [SelectOption!]!
  }
`;

export { crossDatabaseTypeDefs };
