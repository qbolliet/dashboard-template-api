// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition du type des méta-données ─────────────────────────────────────

/**
 * GraphQL type definitions for field metadata queries.
 *
 * Declares the Metadata type, the full contract between the database and the
 * interface (specification-bdd.md §2.2): one row per fact_table column, five
 * columns guaranteed NOT NULL by the writer and six optional UI fields owned
 * by the metadata producer. Also declares the getMetaData query entry point.
 */
const metadataTypeDefs: DocumentNode = gql`
  "Métadonnées d'une colonne de la table des faits — contrat entre la base et l'interface"
  type Metadata {
    "Nom technique de la colonne"
    name: String!
    "Libellé d'affichage (défaut : name)"
    label: String!
    "Type SQL DuckDB (BIGINT, DOUBLE, VARCHAR, …) — pilote les opérateurs de filtre et le choix de graphique"
    sqlType: String!
    "La colonne se filtre par un menu et peut servir de groupBy"
    isCategorical: Boolean!
    "La colonne fait partie de la clé logique — coordonnée plutôt que mesure"
    isPrimaryKey: Boolean!
    "Colonne parente dans une hiérarchie de colonnes (chaîne region → departement → commune)"
    parentName: String
    "Suffixe d'axe / tooltip (« € », « % », « MW »)"
    unit: String
    "Chaîne d3-format (« ,.2f », « .0% »)"
    displayFormat: String
    "Famille thématique — regroupement des variables dans les menus"
    family: String
    "Aide contextuelle"
    description: String
    "Agrégation appliquée par défaut à cette mesure quand la requête n'en précise aucune"
    defaultAggregation: Aggregation
  }

  extend type Query {
    getMetaData(name: String!, catalog: String, schema: String): Metadata
  }
`;

export { metadataTypeDefs };
