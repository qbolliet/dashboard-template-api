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
    "Valeur de la clé commune (libellé porté par la colonne de jointure)"
    key: String!
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
    "Compare les faits de deux datasets (catalogue + schéma) sur des champs de jointure communs. La fact table porte les libellés : la jointure est directe sur les colonnes, alignées en VARCHAR pour absorber une différence de type entre catalogues."
    compareFacts(
      "Premier catalogue (référence)"
      catalogA: String!
      "Second catalogue (comparaison)"
      catalogB: String!
      "Schéma dans catalogA (défaut : schéma configuré du catalogue)"
      schemaA: String
      "Schéma dans catalogB (défaut : schéma configuré du catalogue)"
      schemaB: String
      "Champs utilisés pour la jointure (doivent exister dans les deux datasets)"
      joinFields: [String!]!
      limit: Int! = 100
      offset: Int! = 0
      sort: [SortInput!]
    ): PaginatedComparedFacts!

    "Compare les faits agrégés de deux datasets (catalogue + schéma) sur un groupBy commun. Chaque côté agrège directement sur sa colonne, qui porte le libellé."
    compareAggregatedFacts(
      catalogA: String!
      catalogB: String!
      "Schéma dans catalogA (défaut : schéma configuré du catalogue)"
      schemaA: String
      "Schéma dans catalogB (défaut : schéma configuré du catalogue)"
      schemaB: String
      "Champ de regroupement commun aux deux datasets"
      groupBy: String!
      aggregation: Aggregation! = SUM
      limit: Int! = 100
      offset: Int! = 0
    ): PaginatedComparedFacts!

    "Retourne les options de sélection communes à plusieurs datasets (intersection sur les labels pour les champs catégoriels)"
    crossDatabaseSelectOptions(
      "Nom du champ à intersecter"
      fieldName: String!
      "Liste des catalogues à croiser (minimum 2)"
      catalogs: [String!]!
      "Schémas alignés par index sur 'catalogs' (défaut : schéma configuré de chaque catalogue)"
      schemas: [String!]
      limit: Int! = 50
    ): [SelectOption!]!
  }
`;

export { crossDatabaseTypeDefs };
