// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types pour les comparaisons cross-catalogue ───────────────

/**
 * GraphQL type definitions for cross-database comparison queries.
 *
 * Declares ComparedFact (one key with its value on each side and the deltas),
 * PaginatedComparedFacts (paginated result of compareFacts),
 * AggregateComparison (several aggregates over group columns, in the shape of
 * getAggregates), and three Query entry points comparing facts, aggregates and
 * select options across datasets.
 */
const crossDatabaseTypeDefs: DocumentNode = gql`
  "Comparaison d'une mesure agrégée entre deux datasets pour une clé commune"
  type ComparedFact {
    "Valeur de la clé commune (libellé porté par la colonne de jointure ; valeurs jointes par '::' sur plusieurs champs)"
    key: String!
    "Libellé de la clé quand la comparaison porte sur un seul champ doté de colonnes de libellés (règle par défaut, ANY_VALUE de chaque côté puis COALESCE) ; null sinon"
    keyLabel: String
    "Mesure agrégée dans le dataset A"
    valueA: Float
    "Mesure agrégée dans le dataset B"
    valueB: Float
    "Différence absolue (valueB - valueA)"
    delta: Float
    "Différence relative en % ((valueB - valueA) / valueA * 100) ; null quand valueA vaut 0 ou null"
    deltaPercent: Float
  }

  "Résultat paginé de compareFacts"
  type PaginatedComparedFacts {
    "Une ligne par clé commune aux deux datasets"
    data: [ComparedFact!]!
    "Mesure comparée"
    measure: String!
    "Agrégation appliquée à la mesure de chaque côté"
    aggregation: Aggregation!
    "Nombre de clés communes"
    total: Float!
    hasNextPage: Boolean!
    currentPage: Int!
    totalPages: Float!
  }

  "Résultat de compareAggregatedFacts"
  type AggregateComparison {
    "Colonnes de groupe, dans l'ordre demandé (métadonnées du dataset A ; vide : comparaison globale)"
    groupBy: [GroupColumn!]!
    "Agrégats comparés, dans l'ordre demandé. alias est le préfixe des quatre colonnes de data : <alias>_a, <alias>_b, <alias>_delta (b - a) et <alias>_delta_pct ((b - a) / a * 100, null quand a vaut 0 ou null). sqlType est le type de <alias>_a ; extent couvre <alias>_a et <alias>_b"
    aggregates: [AggregateColumn!]!
    "Ordre des colonnes de data : colonnes de groupe, colonnes de libellés, puis pour chaque agrégat <alias>_a, <alias>_b, <alias>_delta, <alias>_delta_pct"
    columns: [String!]!
    "Une ligne (objet) par groupe commun aux deux datasets. Les colonnes de groupe gardent le type du dataset A ; les libellés sont le COALESCE des deux côtés"
    data: [JSON!]!
    "Nombre de groupes communs aux deux datasets (1 sans groupBy)"
    total: Float!
    "Indique s'il reste des groupes après cette page"
    hasNextPage: Boolean!
    "Horodatage ISO 8601 de construction du résultat"
    generatedAt: String!
  }

  extend type Query {
    "Compare une mesure de deux datasets (catalogue + schéma) sur des champs de jointure communs. Chaque côté est d'abord agrégé par les champs de jointure (une ligne par clé), puis les deux côtés sont joints sur ces champs, alignés en VARCHAR pour absorber une différence de type entre catalogues ; une clé absente d'un côté est écartée."
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
      "Mesure comparée (doit exister dans les deux datasets). Défaut : value ; sans colonne value, BAD_USER_INPUT"
      measure: String
      "Agrégation de la mesure par clé, à résultat numérique. Défaut : metadata.defaultAggregation de la mesure, puis SUM pour une mesure numérique ; si les deux datasets déclarent des agrégations différentes, elle doit être passée"
      aggregation: Aggregation
      limit: Int! = 100
      offset: Int! = 0
      "Tri sur key, keyLabel, valueA, valueB, delta ou deltaPercent, départagé par chaque champ de jointure (ordre croissant)"
      sort: [SortInput!]
    ): PaginatedComparedFacts!

    "Compare plusieurs agrégats de deux datasets (catalogue + schéma) sur des colonnes de groupe communes, dans la forme de getAggregates. Chaque côté est agrégé par la même requête que getAggregates, puis les deux côtés sont joints sur les colonnes de groupe (alignées en VARCHAR) ; un groupe absent d'un côté est écarté. Pagination sur les groupes, triés par sort puis par chaque colonne de groupe (ordre croissant)"
    compareAggregatedFacts(
      "Premier catalogue (référence)"
      catalogA: String!
      "Second catalogue (comparaison)"
      catalogB: String!
      "Schéma dans catalogA (défaut : schéma configuré du catalogue)"
      schemaA: String
      "Schéma dans catalogB (défaut : schéma configuré du catalogue)"
      schemaB: String
      "Colonnes de groupe communes aux deux datasets, au plus API.AGGREGATES.MAX_GROUP_BY ; une colonne tronquée (grain) doit avoir le même type des deux côtés. Vide : une seule ligne globale"
      groupBy: [GroupByInput!] = []
      "Agrégats à comparer, 1 à API.AGGREGATES.MAX_AGGREGATES, à résultat numérique ; l'agrégation effective doit être la même des deux côtés (sinon la passer explicitement)"
      aggregates: [AggregateInput!]!
      "Tri sur une colonne de data (colonne de groupe, de libellés, <alias>_a, _b, _delta ou _delta_pct)"
      sort: [AggregateSortInput!]
      "Nombre de groupes de la page"
      limit: Int! = 100
      offset: Int! = 0
    ): AggregateComparison!

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
