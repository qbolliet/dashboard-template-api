// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types de catalogues DuckLake ─────────────────────────────

/**
 * GraphQL type definitions for DuckLake catalog queries.
 *
 * Declares DatabaseInfo (catalog descriptor with fields and dimension names)
 * and three Query entry points for listing catalogs, fetching a catalog
 * schema, and resolving shared dimensions across multiple catalogs.
 */
const catalogTypeDefs: DocumentNode = gql`
  "Informations sur un catalogue DuckLake disponible"
  type DatabaseInfo {
    "Identifiant du catalogue"
    id: String!
    "Liste de tous les champs et leurs métadonnées"
    fields: [Metadata!]!
    "Noms des dimensions catégorielles disponibles"
    dimensionNames: [String!]!
  }

  extend type Query {
    "Liste tous les catalogues disponibles avec leurs champs et dimensions"
    getDatabases: [DatabaseInfo!]!

    "Retourne tous les champs (métadonnées) d'un catalogue"
    getDatabaseSchema(database: String): [Metadata!]!

    "Retourne les dimensions communes à plusieurs catalogues (utile pour les requêtes cross-database)"
    getSharedDimensions(databases: [String!]!): [String!]!
  }
`;

export { catalogTypeDefs };
