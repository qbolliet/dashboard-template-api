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
    "Liste des schémas DuckLake hébergés par le catalogue (1er = schéma par défaut)"
    schemas: [String!]!
    "Liste de tous les champs et leurs métadonnées (schéma par défaut du catalogue)"
    fields: [Metadata!]!
    "Noms des dimensions catégorielles disponibles (schéma par défaut du catalogue)"
    dimensionNames: [String!]!
  }

  extend type Query {
    "Liste tous les catalogues disponibles avec leurs champs et dimensions"
    getDatabases: [DatabaseInfo!]!

    "Retourne tous les champs (métadonnées) d'un catalogue/schéma"
    getDatabaseSchema(catalog: String, schema: String): [Metadata!]!

    "Retourne les noms des champs au format {value, label} filtrés par type SQL, catégorie, clé primaire ou sous-chaîne du nom (pour alimenter des menus select)"
    getFields(
      catalog: String
      schema: String
      sqlType: String
      isCategorical: Boolean
      isPrimaryKey: Boolean
      namePattern: String
    ): [SelectOption!]!

    "Retourne les dimensions communes à plusieurs catalogues (utile pour les requêtes cross-catalog). Les schémas peuvent être alignés par index sur 'catalogs'."
    getSharedDimensions(catalogs: [String!]!, schemas: [String!]): [String!]!
  }
`;

export { catalogTypeDefs };
