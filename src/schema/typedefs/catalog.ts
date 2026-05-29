// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types de catalogues DuckLake ─────────────────────────────

/**
 * GraphQL type definitions for DuckLake catalog introspection.
 *
 * Declares the Catalog descriptor (id + per-schema details), the
 * CatalogSchemaInfo nested type that exposes fields and dimension names
 * on demand (lazy through GraphQL selection sets), the CatalogSchemaInput
 * value used to address a specific (catalog, schema) pair, and the Query
 * entry points for listing catalogs, fetching a schema's field metadata,
 * filtering fields, and resolving dimensions shared across multiple
 * (catalog, schema) targets.
 */
const catalogTypeDefs: DocumentNode = gql`
  "Informations sur un schéma au sein d'un catalogue (chargement à la demande)"
  type CatalogSchemaInfo {
    "Nom du schéma DuckLake (ex: 'main', 'staging')"
    name: String!
    "Liste des champs et leurs métadonnées (chargé seulement si demandé)"
    fields: [Metadata!]!
    "Noms des dimensions catégorielles (chargé seulement si demandé)"
    dimensionNames: [String!]!
  }

  "Informations sur un catalogue DuckLake disponible"
  type Catalog {
    "Identifiant du catalogue"
    id: String!
    "Schéma utilisé par défaut quand aucun schéma n'est précisé (1er élément de schemas)"
    defaultSchema: String!
    "Schémas DuckLake hébergés par ce catalogue (1er = schéma par défaut). Les sous-champs fields/dimensionNames sont chargés à la demande."
    schemas: [CatalogSchemaInfo!]!
  }

  "Paire (catalogue, schéma) — schema null/absent utilise le schéma par défaut du catalogue"
  input CatalogSchemaInput {
    "Identifiant du catalogue ciblé"
    catalog: String!
    "Nom du schéma ; absent ou null pour utiliser le schéma par défaut"
    schema: String
  }

  extend type Query {
    "Liste tous les catalogues disponibles avec leurs schémas (cascade lazy via les selection sets)"
    getCatalogs: [Catalog!]!

    "Retourne tous les champs (métadonnées) d'un catalogue/schéma"
    getCatalogSchema(catalog: String, schema: String): [Metadata!]!

    "Retourne les noms des champs au format {value, label} filtrés par type SQL, catégorie, clé primaire ou sous-chaîne du nom (pour alimenter des menus select)"
    getFields(
      catalog: String
      schema: String
      sqlType: String
      isCategorical: Boolean
      isPrimaryKey: Boolean
      namePattern: String
    ): [SelectOption!]!

    "Retourne les dimensions communes à plusieurs paires (catalogue, schéma) — utile pour les requêtes cross-catalog"
    getSharedDimensions(targets: [CatalogSchemaInput!]!): [String!]!
  }
`;

export { catalogTypeDefs };
