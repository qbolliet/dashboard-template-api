// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition du type des méta-données ─────────────────────────────────────

/**
 * GraphQL type definitions for field metadata queries.
 *
 * Declares the Metadata type, the full contract between the database and the
 * interface: one row per fact_table column, five
 * columns guaranteed NOT NULL by the writer and seven optional UI fields owned
 * by the metadata producer, plus the derived `labelFields`.
 * Also declares the FieldStats type (on-demand column statistics, read through
 * the lazy `Metadata.stats` field or the filterable getFieldStats query) and
 * the getMetaData query entry point.
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
    "Renseigné sur une colonne de libellés : colonne de code dont elle porte le libellé de chaque valeur (nc8_libelle_fr → nc8)"
    labelFor: String
    "Colonnes de libellés de cette colonne de code (inverse de labelFor), triées par nom ; vide si elle n'en a pas"
    labelFields: [String!]!
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
    "Statistiques de la colonne sur toute la table des faits (bornes de sliders, datepickers, axes). Calculées à la demande, seulement quand ce champ est sélectionné : une requête SQL par colonne. Pour des bornes après filtrage : getFieldStats"
    stats: FieldStats
  }

  """
  Statistiques d'une colonne de la table des faits, calculées à la demande (jamais lues dans le
  catalogue DuckLake, dont les statistiques par fichier sont larges après DELETE et ignorent
  les lignes inlinées).
  """
  type FieldStats {
    "Min de la colonne (nombre ou date ISO), null si colonne vide. Sérialisation du scalaire JSON : entier au-delà de 2^53 en chaîne décimale exacte, DATE en YYYY-MM-DD, TIMESTAMP en ISO 8601. Sur une colonne texte ou booléenne, le min est calculé aussi (ordre lexical ; false < true)"
    min: JSON
    "Max de la colonne, mêmes formes que min, null si colonne vide"
    max: JSON
    "Nombre de valeurs distinctes non NULL"
    distinctCount: Int!
    "Nombre de valeurs NULL"
    nullCount: Int!
  }

  extend type Query {
    getMetaData(name: String!, catalog: String, schema: String): Metadata
    """
    Statistiques d'une colonne, éventuellement restreintes par un arbre de filtres — le même
    que celui des requêtes de faits. Sans filtre, mêmes valeurs (et même cache long) que
    Metadata.stats ; avec filtre, recalibre les sliders après application des filtres courants
    (cache court). Erreur BAD_USER_INPUT si la colonne n'existe pas.
    """
    getFieldStats(
      fieldName: String!
      catalog: String
      schema: String
      "Filter tree (root = group), compiled server-side into a parameterized WHERE clause"
      structuredFilters: FilterNode
    ): FieldStats!
  }
`;

export { metadataTypeDefs };
