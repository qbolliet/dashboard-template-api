// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types de catalogues DuckLake ─────────────────────────────

/**
 * GraphQL type definitions for DuckLake catalog introspection.
 *
 * Declares the Catalog descriptor (id + per-schema details), the
 * CatalogSchemaInfo nested type that exposes fields on demand (lazy through
 * GraphQL selection sets), the CatalogSchemaInput value used to address a
 * specific (catalog, schema) pair, and the Query entry points for listing
 * catalogs, fetching a schema's field metadata, filtering fields, and
 * resolving the fields shared across multiple (catalog, schema) targets.
 */
const catalogTypeDefs: DocumentNode = gql`
  "Informations sur un schéma au sein d'un catalogue (chargement à la demande)"
  type CatalogSchemaInfo {
    "Nom du schéma DuckLake (ex: 'main', 'staging')"
    name: String!
    "Liste des champs et leurs métadonnées (chargé seulement si demandé)"
    fields: [Metadata!]!
    "Méta-données du jeu de résultats (chargé seulement si demandé)"
    info: DatasetInfo!
  }

  "Méta-données d'un jeu de résultats — une ligne de dataset_metadata par schéma"
  type DatasetInfo {
    "Titre du jeu de résultats"
    label: String
    "Sous-titre / description"
    description: String
    "Provenance (modèle, pipeline)"
    source: String
    "Horodatage ISO 8601 de la dernière écriture réussie"
    updatedAt: String!
    "Version du format de schéma de la base"
    schemaVersion: Int!
    "Colonnes de tri physique (cluster_by décodé) — ordre de pagination par défaut"
    clusterBy: [String!]!
  }

  "Informations sur un catalogue DuckLake disponible"
  type Catalog {
    "Identifiant du catalogue"
    id: String!
    "Schéma utilisé par défaut quand aucun schéma n'est précisé (1er élément de schemas)"
    defaultSchema: String!
    "Schémas DuckLake hébergés par ce catalogue (1er = schéma par défaut). Le sous-champ fields est chargé à la demande."
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

    "Retourne tous les champs (métadonnées) d'un catalogue/schéma, colonnes de libellés comprises (contrat complet)"
    getCatalogSchema(catalog: String, schema: String): [Metadata!]!

    "Retourne les méta-données du jeu de résultats d'un catalogue/schéma (titre, fraîcheur, tri physique)"
    getDatasetInfo(catalog: String, schema: String): DatasetInfo!

    "Retourne les noms des champs au format {value, label} filtrés par type SQL, catégorie, clé primaire, famille thématique ou sous-chaîne du nom (pour alimenter des menus select). Les colonnes de libellés sont exclues sauf includeLabelFields: true"
    getFields(
      catalog: String
      schema: String
      sqlType: String
      isCategorical: Boolean
      isPrimaryKey: Boolean
      namePattern: String
      family: String
      "Inclut les colonnes de libellés (labelFor renseigné), masquées par défaut : ce ne sont pas des variables à proposer dans un menu"
      includeLabelFields: Boolean = false
    ): [SelectOption!]!

    "Retourne les champs communs à plusieurs paires (catalogue, schéma) — utile pour choisir les joinFields d'une requête cross-catalog. Seules les colonnes CATÉGORIELLES présentes dans toutes les cibles sous le même nom et avec la même famille de type SQL (numérique, date, texte, booléen) sont retournées ; les colonnes de libellés sont exclues (la jointure porte sur le code)."
    getSharedFields(targets: [CatalogSchemaInput!]!): [String!]!
  }
`;

export { catalogTypeDefs };
