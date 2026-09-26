import type { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
import type { FieldMetadata } from '../utils/metadata-mapping.js';
import type { GraphQLContext } from '../schema/resolvers/types.js';
export type Maybe<T> = T | null;
export type InputMaybe<T> = T | null | undefined;
export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /**
   * Custom scalar type for JSON values. Value types coming from the fact table are
   * serialized the same way on every path (rows as objects or arrays, aggregates, comparisons):
   * integers (TINYINT to UBIGINT, HUGEINT) are JSON numbers when Number.isSafeInteger holds and
   * their exact decimal string beyond (|value| > 2^53 - 1); DECIMAL, FLOAT and DOUBLE are JSON
   * numbers (NaN and ±Infinity become null); DATE is "YYYY-MM-DD"; TIMESTAMP is ISO 8601 with a
   * T separator, "YYYY-MM-DDTHH:mm:ss[.sss]", with a Z suffix (UTC) only for the types carrying a
   * time zone; BOOLEAN is a boolean; NULL is null.
   */
  JSON: { input: unknown; output: unknown; }
};

/** An aggregated fact record with key and value */
export type AggregatedFact = {
  /** Aggregated value */
  aggregatedValue: Scalars['Float']['output'];
  /** Number of records in this group */
  count: Scalars['Int']['output'];
  /** Grouping key */
  key: Scalars['String']['output'];
  /** Label of the grouping key when the group column is a code with label columns (Metadata.labelFields, default rule: the only one, or the first by alphabetical order), read by ANY_VALUE in the same query; null otherwise */
  keyLabel?: Maybe<Scalars['String']['output']>;
};

/** Metadata for aggregated facts optimized for D3 */
export type AggregatedFactsMetadata = {
  count: Scalars['Int']['output'];
  /** ISO 8601 timestamp of when this query was executed */
  generatedAt: Scalars['String']['output'];
  groupByFieldInfo?: Maybe<Metadata>;
  keyExtent?: Maybe<Scalars['JSON']['output']>;
  /** Metadata of the aggregated measure (unit and display format of the aggregated value) */
  measureFieldInfo?: Maybe<Metadata>;
  statistics?: Maybe<AggregationStatistics>;
  valueExtent: Array<Scalars['Float']['output']>;
};

/** Aggregated facts with D3-optimized metadata */
export type AggregatedFactsWithMetadata = {
  data: Array<AggregatedFact>;
  metadata: AggregatedFactsMetadata;
};

export type Aggregation =
  | 'AVG'
  | 'COUNT'
  | 'MAX'
  | 'MEDIAN'
  | 'MIN'
  | 'MODE'
  | 'SUM';

/** Statistics for aggregated data */
export type AggregationStatistics = {
  mean?: Maybe<Scalars['Float']['output']>;
  median?: Maybe<Scalars['Float']['output']>;
  quartiles?: Maybe<Array<Maybe<Scalars['Float']['output']>>>;
  stdDev?: Maybe<Scalars['Float']['output']>;
};

/** Informations sur un catalogue DuckLake disponible */
export type Catalog = {
  /** Schéma utilisé par défaut quand aucun schéma n'est précisé (1er élément de schemas) */
  defaultSchema: Scalars['String']['output'];
  /** Identifiant du catalogue */
  id: Scalars['String']['output'];
  /** Schémas DuckLake hébergés par ce catalogue (1er = schéma par défaut). Le sous-champ fields est chargé à la demande. */
  schemas: Array<CatalogSchemaInfo>;
};

/** Informations sur un schéma au sein d'un catalogue (chargement à la demande) */
export type CatalogSchemaInfo = {
  /** Liste des champs et leurs métadonnées (chargé seulement si demandé) */
  fields: Array<Metadata>;
  /** Méta-données du jeu de résultats (chargé seulement si demandé) */
  info: DatasetInfo;
  /** Nom du schéma DuckLake (ex: 'main', 'staging') */
  name: Scalars['String']['output'];
};

/** Paire (catalogue, schéma) — schema null/absent utilise le schéma par défaut du catalogue */
export type CatalogSchemaInput = {
  /** Identifiant du catalogue ciblé */
  catalog: Scalars['String']['input'];
  /** Nom du schéma ; absent ou null pour utiliser le schéma par défaut */
  schema?: InputMaybe<Scalars['String']['input']>;
};

/** Comparaison d'une valeur entre deux catalogues sur une clé commune */
export type ComparedFact = {
  /** Différence absolue (valueB - valueA) */
  delta?: Maybe<Scalars['Float']['output']>;
  /** Différence relative en % ((valueB - valueA) / valueA * 100) */
  deltaPercent?: Maybe<Scalars['Float']['output']>;
  /** Valeur de la clé commune (libellé porté par la colonne de jointure) */
  key: Scalars['String']['output'];
  /** Libellé de la clé quand la comparaison porte sur un seul champ doté de colonnes de libellés (règle par défaut, COALESCE des deux côtés, même requête) ; null sinon */
  keyLabel?: Maybe<Scalars['String']['output']>;
  /** Valeur dans le catalogue A */
  valueA?: Maybe<Scalars['Float']['output']>;
  /** Valeur dans le catalogue B */
  valueB?: Maybe<Scalars['Float']['output']>;
};

/** Format de sérialisation des données pour getFactTableWithMetadata */
export type DataFormat =
  /** Tableau de tableaux [[val1, val2, ...]] — plus compact, optimisé pour AG Grid / TanStack */
  | 'ARRAYS'
  /** Tableau d'objets [{col: val, ...}] — format par défaut, compatible D3 et DataTable */
  | 'OBJECTS';

/** Méta-données d'un jeu de résultats — une ligne de dataset_metadata par schéma */
export type DatasetInfo = {
  /** Colonnes de tri physique (cluster_by décodé) — ordre de pagination par défaut */
  clusterBy: Array<Scalars['String']['output']>;
  /** Sous-titre / description */
  description?: Maybe<Scalars['String']['output']>;
  /** Titre du jeu de résultats */
  label?: Maybe<Scalars['String']['output']>;
  /** Version du format de schéma de la base */
  schemaVersion: Scalars['Int']['output'];
  /** Provenance (modèle, pipeline) */
  source?: Maybe<Scalars['String']['output']>;
  /** Horodatage ISO 8601 de la dernière écriture réussie */
  updatedAt: Scalars['String']['output'];
};

/** Metadata about a dataset, useful for visualization */
export type DatasetMetadata = {
  /** Number of records in current page */
  count: Scalars['Int']['output'];
  /** Current page number (1-indexed) */
  currentPage?: Maybe<Scalars['Int']['output']>;
  /** Bounds of the columns of THIS PAGE (not of the whole dataset), keyed by column name: [min, max] as numbers for numeric columns (integers beyond 2^53, serialized as strings, are compared as numbers, so their bound is approximate), [min, max] as ISO 8601 strings for date and timestamp columns (chronological comparison). NULLs are ignored; a column with no value has no entry. Global bounds of a column: Metadata.stats */
  extents?: Maybe<Scalars['JSON']['output']>;
  /** ISO 8601 timestamp of when this query was executed */
  generatedAt: Scalars['String']['output'];
  /** Whether there are more pages available */
  hasNextPage?: Maybe<Scalars['Boolean']['output']>;
  /** Total number of records matching the query */
  total?: Maybe<Scalars['Int']['output']>;
  /** Total number of pages */
  totalPages?: Maybe<Scalars['Int']['output']>;
};

/** D3-optimized data format with metadata */
export type DatasetWithMetadata = {
  /** Column names in the dataset */
  columns: Array<Scalars['String']['output']>;
  /** Rows, as JSON objects (OBJECTS) or arrays ordered as columns (ARRAYS). Value types are guaranteed, see the JSON scalar */
  data: Array<Scalars['JSON']['output']>;
  /** Metadata of the returned columns — same names, same order as columns (axis type, header label, unit, display format…). Fails explicitly when a column has no row in the metadata table */
  fields: Array<Metadata>;
  /** Metadata about the dataset */
  metadata: DatasetMetadata;
};

/** A single fact record from the fact table, split into its coordinates and its measures */
export type Fact = {
  /** Coordinates of the row — every column with isPrimaryKey = true, NULL levels of a column hierarchy included */
  keys: Array<FieldValue>;
  /** Measures of the row — every column with isPrimaryKey = false */
  measures: Array<FieldValue>;
};

/**
 * Statistiques d'une colonne de la table des faits, calculées à la demande (jamais lues dans le
 * catalogue DuckLake, dont les statistiques par fichier sont larges après DELETE et ignorent
 * les lignes inlinées).
 */
export type FieldStats = {
  /** Nombre de valeurs distinctes non NULL */
  distinctCount: Scalars['Int']['output'];
  /** Max de la colonne, mêmes formes que min, null si colonne vide */
  max?: Maybe<Scalars['JSON']['output']>;
  /** Min de la colonne (nombre ou date ISO), null si colonne vide. Sérialisation du scalaire JSON : entier au-delà de 2^53 en chaîne décimale exacte, DATE en YYYY-MM-DD, TIMESTAMP en ISO 8601. Sur une colonne texte ou booléenne, le min est calculé aussi (ordre lexical ; false < true) */
  min?: Maybe<Scalars['JSON']['output']>;
  /** Nombre de valeurs NULL */
  nullCount: Scalars['Int']['output'];
};

/** A single named column value of a fact row. The value preserves its original type (Float, Int, String, Boolean…) via the JSON scalar. */
export type FieldValue = {
  /** Name of the column (e.g. country, date, value, lower_bound) */
  name: Scalars['String']['output'];
  /** Raw column value, original type preserved. NULL is returned as null. */
  value?: Maybe<Scalars['JSON']['output']>;
};

/** Logical connector between a filter node and the PREVIOUS node of the same group. AND, OR, AND_NOT and OR_NOT follow SQL precedence (NOT, then AND, then OR); XOR, XNOR, NAND and NOR take everything on their left as a single operand. A NULL operand yields NULL (row not selected), except NOR which is true only when both sides are false. */
export type FilterConnector =
  /** a AND b */
  | 'AND'
  /** a AND NOT b */
  | 'AND_NOT'
  /** Not both: NOT (a AND b) */
  | 'NAND'
  /** Neither: NOT (a OR b) */
  | 'NOR'
  /** a OR b */
  | 'OR'
  /** a OR NOT b */
  | 'OR_NOT'
  /** Equivalence: both hold, or neither does */
  | 'XNOR'
  /** Exclusive or: exactly one of the two holds */
  | 'XOR';

/** A single filter criterion on one column */
export type FilterCriterion = {
  /** Operation to apply, compatible with the column's SQL type family */
  operation: FilterOperation;
  /** Scalar (string, number, boolean) for comparisons; non-empty array for IN/NOT_IN; {min, max} for BETWEEN; omitted for IS_NULL/IS_NOT_NULL. Dates in ISO 8601; integers beyond 2^53 as strings. */
  value?: InputMaybe<Scalars['JSON']['input']>;
  /** Column name (must exist in the metadata table) */
  variable: Scalars['String']['input'];
};

/** Node of a filter tree. Exactly one of criterion (leaf) or children (group) must be set; groups must not be empty. The root node must be a group. */
export type FilterNode = {
  /** Child nodes of a group (mutually exclusive with criterion; sub-groups are parenthesized) */
  children?: InputMaybe<Array<FilterNode>>;
  /** Connector with the previous node of the parent group (ignored for the first node, defaults to AND) */
  connector?: InputMaybe<FilterConnector>;
  /** Leaf criterion (mutually exclusive with children) */
  criterion?: InputMaybe<FilterCriterion>;
  /** Negates this node: NOT on the leaf predicate, or on the whole group */
  negate?: InputMaybe<Scalars['Boolean']['input']>;
};

/** Filter operation. The allowed set depends on the column's SQL type family, read server-side from metadata.sqlType: numeric (EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN IS_NULL IS_NOT_NULL), date (EQ NEQ BEFORE AFTER BETWEEN IS_NULL IS_NOT_NULL), text (EQ NEQ CONTAINS STARTS IN NOT_IN IS_NULL IS_NOT_NULL), boolean (EQ NEQ IS_NULL IS_NOT_NULL) */
export type FilterOperation =
  | 'AFTER'
  /** Date comparisons (strict, then inclusive) */
  | 'BEFORE'
  /** Range, bounds included (numeric, date) — value {min, max} */
  | 'BETWEEN'
  /** Text matching (LIKE); wildcards % and _ in the value are escaped */
  | 'CONTAINS'
  | 'ENDS'
  /** Equality / inequality (all families) */
  | 'EQ'
  /** Numeric comparisons */
  | 'GT'
  | 'GTE'
  | 'ICONTAINS'
  | 'IENDS'
  /** Case-insensitive text matching (ILIKE); IEQ is case-insensitive equality */
  | 'IEQ'
  /** Membership — value is a non-empty array */
  | 'IN'
  | 'ISTARTS'
  | 'IS_FALSE'
  | 'IS_NOT_FALSE'
  | 'IS_NOT_NULL'
  | 'IS_NOT_TRUE'
  /** Value-less operations */
  | 'IS_NULL'
  /** Boolean shortcuts; the IS_NOT_* forms also match NULL */
  | 'IS_TRUE'
  | 'LT'
  | 'LTE'
  /** Regular expression (DuckDB regexp_matches, RE2 syntax; no backreferences or lookaround) */
  | 'MATCHES'
  | 'NEQ'
  | 'NOT_BETWEEN'
  | 'NOT_CONTAINS'
  | 'NOT_ENDS'
  | 'NOT_IN'
  | 'NOT_STARTS'
  | 'ON_OR_AFTER'
  | 'ON_OR_BEFORE'
  | 'STARTS';

/** Métadonnées d'une colonne de la table des faits — contrat entre la base et l'interface */
export type Metadata = {
  /** Agrégation appliquée par défaut à cette mesure quand la requête n'en précise aucune */
  defaultAggregation?: Maybe<Aggregation>;
  /** Aide contextuelle */
  description?: Maybe<Scalars['String']['output']>;
  /** Chaîne d3-format (« ,.2f », « .0% ») */
  displayFormat?: Maybe<Scalars['String']['output']>;
  /** Famille thématique — regroupement des variables dans les menus */
  family?: Maybe<Scalars['String']['output']>;
  /** La colonne se filtre par un menu et peut servir de groupBy */
  isCategorical: Scalars['Boolean']['output'];
  /** La colonne fait partie de la clé logique — coordonnée plutôt que mesure */
  isPrimaryKey: Scalars['Boolean']['output'];
  /** Libellé d'affichage (défaut : name) */
  label: Scalars['String']['output'];
  /** Colonnes de libellés de cette colonne de code (inverse de labelFor), triées par nom ; vide si elle n'en a pas */
  labelFields: Array<Scalars['String']['output']>;
  /** Renseigné sur une colonne de libellés : colonne de code dont elle porte le libellé de chaque valeur (nc8_libelle_fr → nc8) */
  labelFor?: Maybe<Scalars['String']['output']>;
  /** Nom technique de la colonne */
  name: Scalars['String']['output'];
  /** Colonne parente dans une hiérarchie de colonnes (chaîne region → departement → commune) */
  parentName?: Maybe<Scalars['String']['output']>;
  /** Type SQL DuckDB (BIGINT, DOUBLE, VARCHAR, …) — pilote les opérateurs de filtre et le choix de graphique */
  sqlType: Scalars['String']['output'];
  /** Statistiques de la colonne sur toute la table des faits (bornes de sliders, datepickers, axes). Calculées à la demande, seulement quand ce champ est sélectionné : une requête SQL par colonne. Pour des bornes après filtrage : getFieldStats */
  stats?: Maybe<FieldStats>;
  /** Suffixe d'axe / tooltip (« € », « % », « MW ») */
  unit?: Maybe<Scalars['String']['output']>;
};

/** Résultat paginé pour les comparaisons cross-database */
export type PaginatedComparedFacts = {
  currentPage: Scalars['Int']['output'];
  data: Array<ComparedFact>;
  hasNextPage: Scalars['Boolean']['output'];
  total: Scalars['Int']['output'];
  totalPages: Scalars['Int']['output'];
};

/** Paginated response for fact queries */
export type PaginatedFacts = {
  /** Current page number (1-indexed) */
  currentPage?: Maybe<Scalars['Int']['output']>;
  /** Array of fact records */
  data?: Maybe<Array<Maybe<Fact>>>;
  /** Whether there are more pages available */
  hasNextPage?: Maybe<Scalars['Boolean']['output']>;
  /** Total number of records matching the query */
  total?: Maybe<Scalars['Int']['output']>;
  /** Total number of pages */
  totalPages?: Maybe<Scalars['Int']['output']>;
};

export type Query = {
  _empty?: Maybe<Scalars['String']['output']>;
  /** Compare les faits agrégés de deux datasets (catalogue + schéma) sur un groupBy commun. Chaque côté agrège directement sur sa colonne, qui porte le libellé. */
  compareAggregatedFacts: PaginatedComparedFacts;
  /** Compare les faits de deux datasets (catalogue + schéma) sur des champs de jointure communs. La fact table porte les libellés : la jointure est directe sur les colonnes, alignées en VARCHAR pour absorber une différence de type entre catalogues. */
  compareFacts: PaginatedComparedFacts;
  /** Retourne les options de sélection communes à plusieurs datasets (intersection sur les labels pour les champs catégoriels) */
  crossDatabaseSelectOptions: Array<SelectOption>;
  /** Get aggregated facts for charts and summaries */
  getAggregatedFacts?: Maybe<Array<Maybe<AggregatedFact>>>;
  /** Get aggregated facts with D3 metadata */
  getAggregatedFactsWithMetadata?: Maybe<AggregatedFactsWithMetadata>;
  /** Retourne tous les champs (métadonnées) d'un catalogue/schéma, colonnes de libellés comprises (contrat complet) */
  getCatalogSchema: Array<Metadata>;
  /** Liste tous les catalogues disponibles avec leurs schémas (cascade lazy via les selection sets) */
  getCatalogs: Array<Catalog>;
  /** Retourne les méta-données du jeu de résultats d'un catalogue/schéma (titre, fraîcheur, tri physique) */
  getDatasetInfo: DatasetInfo;
  /** Get fact table data with pagination and filtering */
  getFactTable?: Maybe<PaginatedFacts>;
  /** Get fact data optimized for D3 visualization */
  getFactTableWithMetadata?: Maybe<DatasetWithMetadata>;
  /**
   * Statistiques d'une colonne, éventuellement restreintes par un arbre de filtres — le même
   * que celui des requêtes de faits. Sans filtre, mêmes valeurs (et même cache long) que
   * Metadata.stats ; avec filtre, recalibre les sliders après application des filtres courants
   * (cache court). Erreur BAD_USER_INPUT si la colonne n'existe pas.
   */
  getFieldStats: FieldStats;
  /** Retourne les noms des champs au format {value, label} filtrés par type SQL, catégorie, clé primaire, famille thématique ou sous-chaîne du nom (pour alimenter des menus select). Les colonnes de libellés sont exclues sauf includeLabelFields: true */
  getFields: Array<SelectOption>;
  getMetaData?: Maybe<Metadata>;
  /**
   * Distinct values of one column, with search and limit. `label = value`,
   * except for a code column with label columns (`Metadata.labelFields`):
   * `value` is the code (cast to text), `label` its label — the code itself
   * when the label is NULL. `searchTerm` then matches the code or the label.
   */
  getSelectOptions: Array<SelectOption>;
  /**
   * Nested option tree of a column hierarchy, `fieldName` being the deepest
   * level displayed. The chain of columns is walked up from `fieldName`
   * through `Metadata.parentName`; the tree is read with a single
   * `SELECT DISTINCT` over that chain.
   *
   * Shape: `[{ value, label, children? }]` — `children` is absent on leaves.
   * `label` equals `value` unless the level is a code column with label
   * columns (`Metadata.labelFields`): each level then reads its label from its
   * own label column, chosen by the default rule of `getSelectOptions` (the
   * only one, or the first by alphabetical order; no per-level argument), and
   * falls back to the code when the label is NULL. A node is still one code.
   * A NULL level ends its branch: the parent becomes a leaf, no empty node is
   * ever produced. A column without `parentName` yields a one-level tree (a
   * list of leaves).
   *
   * Example on the chain `region → departement → commune`:
   * `getSelectOptionsTree(fieldName: "commune", maxDepth: 2)` returns
   * `[{ value: "Côte-d'Or", label: "Côte-d'Or", children: [{ value: "Beaune",
   * label: "Beaune" }, …] }, …]` — departements holding their own communes,
   * i.e. the group-options format of a select menu. Without `maxDepth` the
   * regions are the roots and the tree has three levels.
   *
   * Example on the code chain `nc6 → nc8` (labels `nc6_libelle`,
   * `nc8_libelle_en`, `nc8_libelle_fr`):
   * `getSelectOptionsTree(fieldName: "nc8")` returns `[{ value: "010121",
   * label: "Chevaux reproducteurs de race pure", children: [{ value: "01012100",
   * label: "Pure-bred breeding horses" }] }, …]` — `nc8` takes `nc8_libelle_en`,
   * first by alphabetical order; use `getSelectOptions(labelField: …)` on the
   * leaf level for another label column.
   *
   * Trees larger than the configured node bound (API.SELECT_OPTIONS.TREE_MAX_NODES)
   * are rejected with BAD_USER_INPUT, never truncated: narrow them with
   * `searchTerm` or `maxDepth`, or use `getSelectOptions` on the leaf level.
   */
  getSelectOptionsTree: Scalars['JSON']['output'];
  /** Retourne les champs communs à plusieurs paires (catalogue, schéma) — utile pour choisir les joinFields d'une requête cross-catalog. Seules les colonnes CATÉGORIELLES présentes dans toutes les cibles sous le même nom et avec la même famille de type SQL (numérique, date, texte, booléen) sont retournées ; les colonnes de libellés sont exclues (la jointure porte sur le code). */
  getSharedFields: Array<Scalars['String']['output']>;
};


export type QueryCompareAggregatedFactsArgs = {
  aggregation?: Aggregation;
  catalogA: Scalars['String']['input'];
  catalogB: Scalars['String']['input'];
  groupBy: Scalars['String']['input'];
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  schemaA?: InputMaybe<Scalars['String']['input']>;
  schemaB?: InputMaybe<Scalars['String']['input']>;
};


export type QueryCompareFactsArgs = {
  catalogA: Scalars['String']['input'];
  catalogB: Scalars['String']['input'];
  joinFields: Array<Scalars['String']['input']>;
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  schemaA?: InputMaybe<Scalars['String']['input']>;
  schemaB?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Array<SortInput>>;
};


export type QueryCrossDatabaseSelectOptionsArgs = {
  catalogs: Array<Scalars['String']['input']>;
  fieldName: Scalars['String']['input'];
  limit?: Scalars['Int']['input'];
  schemas?: InputMaybe<Array<Scalars['String']['input']>>;
};


export type QueryGetAggregatedFactsArgs = {
  aggregation?: InputMaybe<Aggregation>;
  catalog?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Array<Scalars['String']['input']>>;
  groupBy: Scalars['String']['input'];
  limit?: Scalars['Int']['input'];
  measure: Scalars['String']['input'];
  offset?: Scalars['Int']['input'];
  schema?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Array<SortInput>>;
  structuredFilters?: InputMaybe<FilterNode>;
};


export type QueryGetAggregatedFactsWithMetadataArgs = {
  aggregation?: InputMaybe<Aggregation>;
  catalog?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Array<Scalars['String']['input']>>;
  groupBy: Scalars['String']['input'];
  limit?: Scalars['Int']['input'];
  measure: Scalars['String']['input'];
  offset?: Scalars['Int']['input'];
  schema?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Array<SortInput>>;
  structuredFilters?: InputMaybe<FilterNode>;
};


export type QueryGetCatalogSchemaArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  schema?: InputMaybe<Scalars['String']['input']>;
};


export type QueryGetDatasetInfoArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  schema?: InputMaybe<Scalars['String']['input']>;
};


export type QueryGetFactTableArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Array<Scalars['String']['input']>>;
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  schema?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Array<SortInput>>;
  structuredFilters?: InputMaybe<FilterNode>;
};


export type QueryGetFactTableWithMetadataArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Array<Scalars['String']['input']>>;
  format?: InputMaybe<DataFormat>;
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  schema?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Array<SortInput>>;
  structuredFilters?: InputMaybe<FilterNode>;
};


export type QueryGetFieldStatsArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  fieldName: Scalars['String']['input'];
  schema?: InputMaybe<Scalars['String']['input']>;
  structuredFilters?: InputMaybe<FilterNode>;
};


export type QueryGetFieldsArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  family?: InputMaybe<Scalars['String']['input']>;
  includeLabelFields?: InputMaybe<Scalars['Boolean']['input']>;
  isCategorical?: InputMaybe<Scalars['Boolean']['input']>;
  isPrimaryKey?: InputMaybe<Scalars['Boolean']['input']>;
  namePattern?: InputMaybe<Scalars['String']['input']>;
  schema?: InputMaybe<Scalars['String']['input']>;
  sqlType?: InputMaybe<Scalars['String']['input']>;
};


export type QueryGetMetaDataArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  schema?: InputMaybe<Scalars['String']['input']>;
};


export type QueryGetSelectOptionsArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  fieldName: Scalars['String']['input'];
  labelField?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  schema?: InputMaybe<Scalars['String']['input']>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
};


export type QueryGetSelectOptionsTreeArgs = {
  catalog?: InputMaybe<Scalars['String']['input']>;
  fieldName: Scalars['String']['input'];
  maxDepth?: InputMaybe<Scalars['Int']['input']>;
  schema?: InputMaybe<Scalars['String']['input']>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
};


export type QueryGetSharedFieldsArgs = {
  targets: Array<CatalogSchemaInput>;
};

export type SelectOption = {
  label: Scalars['String']['output'];
  value: Scalars['String']['output'];
};

export type SortInput = {
  field: Scalars['String']['input'];
  order?: InputMaybe<SortOrder>;
};

export type SortOrder =
  | 'ASC'
  | 'DESC';



export type ResolverTypeWrapper<T> = Promise<T> | T;


export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = Record<PropertyKey, never>, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;





/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = {
  AggregatedFact: ResolverTypeWrapper<AggregatedFact>;
  AggregatedFactsMetadata: ResolverTypeWrapper<Omit<AggregatedFactsMetadata, 'groupByFieldInfo' | 'measureFieldInfo'> & { groupByFieldInfo?: Maybe<ResolversTypes['Metadata']>, measureFieldInfo?: Maybe<ResolversTypes['Metadata']> }>;
  AggregatedFactsWithMetadata: ResolverTypeWrapper<Omit<AggregatedFactsWithMetadata, 'metadata'> & { metadata: ResolversTypes['AggregatedFactsMetadata'] }>;
  Aggregation: Aggregation;
  AggregationStatistics: ResolverTypeWrapper<AggregationStatistics>;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  Catalog: ResolverTypeWrapper<Omit<Catalog, 'schemas'> & { schemas: Array<ResolversTypes['CatalogSchemaInfo']> }>;
  CatalogSchemaInfo: ResolverTypeWrapper<Omit<CatalogSchemaInfo, 'fields'> & { fields: Array<ResolversTypes['Metadata']> }>;
  CatalogSchemaInput: CatalogSchemaInput;
  ComparedFact: ResolverTypeWrapper<ComparedFact>;
  DataFormat: DataFormat;
  DatasetInfo: ResolverTypeWrapper<DatasetInfo>;
  DatasetMetadata: ResolverTypeWrapper<DatasetMetadata>;
  DatasetWithMetadata: ResolverTypeWrapper<Omit<DatasetWithMetadata, 'fields'> & { fields: Array<ResolversTypes['Metadata']> }>;
  Fact: ResolverTypeWrapper<Fact>;
  FieldStats: ResolverTypeWrapper<FieldStats>;
  FieldValue: ResolverTypeWrapper<FieldValue>;
  FilterConnector: FilterConnector;
  FilterCriterion: FilterCriterion;
  FilterNode: FilterNode;
  FilterOperation: FilterOperation;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  JSON: ResolverTypeWrapper<Scalars['JSON']['output']>;
  Metadata: ResolverTypeWrapper<FieldMetadata>;
  PaginatedComparedFacts: ResolverTypeWrapper<PaginatedComparedFacts>;
  PaginatedFacts: ResolverTypeWrapper<PaginatedFacts>;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  SelectOption: ResolverTypeWrapper<SelectOption>;
  SortInput: SortInput;
  SortOrder: SortOrder;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  AggregatedFact: AggregatedFact;
  AggregatedFactsMetadata: Omit<AggregatedFactsMetadata, 'groupByFieldInfo' | 'measureFieldInfo'> & { groupByFieldInfo?: Maybe<ResolversParentTypes['Metadata']>, measureFieldInfo?: Maybe<ResolversParentTypes['Metadata']> };
  AggregatedFactsWithMetadata: Omit<AggregatedFactsWithMetadata, 'metadata'> & { metadata: ResolversParentTypes['AggregatedFactsMetadata'] };
  AggregationStatistics: AggregationStatistics;
  Boolean: Scalars['Boolean']['output'];
  Catalog: Omit<Catalog, 'schemas'> & { schemas: Array<ResolversParentTypes['CatalogSchemaInfo']> };
  CatalogSchemaInfo: Omit<CatalogSchemaInfo, 'fields'> & { fields: Array<ResolversParentTypes['Metadata']> };
  CatalogSchemaInput: CatalogSchemaInput;
  ComparedFact: ComparedFact;
  DatasetInfo: DatasetInfo;
  DatasetMetadata: DatasetMetadata;
  DatasetWithMetadata: Omit<DatasetWithMetadata, 'fields'> & { fields: Array<ResolversParentTypes['Metadata']> };
  Fact: Fact;
  FieldStats: FieldStats;
  FieldValue: FieldValue;
  FilterCriterion: FilterCriterion;
  FilterNode: FilterNode;
  Float: Scalars['Float']['output'];
  Int: Scalars['Int']['output'];
  JSON: Scalars['JSON']['output'];
  Metadata: FieldMetadata;
  PaginatedComparedFacts: PaginatedComparedFacts;
  PaginatedFacts: PaginatedFacts;
  Query: Record<PropertyKey, never>;
  SelectOption: SelectOption;
  SortInput: SortInput;
  String: Scalars['String']['output'];
};

export type AggregatedFactResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AggregatedFact'] = ResolversParentTypes['AggregatedFact']> = {
  aggregatedValue?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  key?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  keyLabel?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type AggregatedFactsMetadataResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AggregatedFactsMetadata'] = ResolversParentTypes['AggregatedFactsMetadata']> = {
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  groupByFieldInfo?: Resolver<Maybe<ResolversTypes['Metadata']>, ParentType, ContextType>;
  keyExtent?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  measureFieldInfo?: Resolver<Maybe<ResolversTypes['Metadata']>, ParentType, ContextType>;
  statistics?: Resolver<Maybe<ResolversTypes['AggregationStatistics']>, ParentType, ContextType>;
  valueExtent?: Resolver<Array<ResolversTypes['Float']>, ParentType, ContextType>;
};

export type AggregatedFactsWithMetadataResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AggregatedFactsWithMetadata'] = ResolversParentTypes['AggregatedFactsWithMetadata']> = {
  data?: Resolver<Array<ResolversTypes['AggregatedFact']>, ParentType, ContextType>;
  metadata?: Resolver<ResolversTypes['AggregatedFactsMetadata'], ParentType, ContextType>;
};

export type AggregationStatisticsResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AggregationStatistics'] = ResolversParentTypes['AggregationStatistics']> = {
  mean?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  median?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  quartiles?: Resolver<Maybe<Array<Maybe<ResolversTypes['Float']>>>, ParentType, ContextType>;
  stdDev?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
};

export type CatalogResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Catalog'] = ResolversParentTypes['Catalog']> = {
  defaultSchema?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schemas?: Resolver<Array<ResolversTypes['CatalogSchemaInfo']>, ParentType, ContextType>;
};

export type CatalogSchemaInfoResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['CatalogSchemaInfo'] = ResolversParentTypes['CatalogSchemaInfo']> = {
  fields?: Resolver<Array<ResolversTypes['Metadata']>, ParentType, ContextType>;
  info?: Resolver<ResolversTypes['DatasetInfo'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type ComparedFactResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ComparedFact'] = ResolversParentTypes['ComparedFact']> = {
  delta?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  deltaPercent?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  key?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  keyLabel?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  valueA?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  valueB?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
};

export type DatasetInfoResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['DatasetInfo'] = ResolversParentTypes['DatasetInfo']> = {
  clusterBy?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  label?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schemaVersion?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type DatasetMetadataResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['DatasetMetadata'] = ResolversParentTypes['DatasetMetadata']> = {
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  currentPage?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  extents?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  generatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  hasNextPage?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  total?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  totalPages?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
};

export type DatasetWithMetadataResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['DatasetWithMetadata'] = ResolversParentTypes['DatasetWithMetadata']> = {
  columns?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  data?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  fields?: Resolver<Array<ResolversTypes['Metadata']>, ParentType, ContextType>;
  metadata?: Resolver<ResolversTypes['DatasetMetadata'], ParentType, ContextType>;
};

export type FactResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Fact'] = ResolversParentTypes['Fact']> = {
  keys?: Resolver<Array<ResolversTypes['FieldValue']>, ParentType, ContextType>;
  measures?: Resolver<Array<ResolversTypes['FieldValue']>, ParentType, ContextType>;
};

export type FieldStatsResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FieldStats'] = ResolversParentTypes['FieldStats']> = {
  distinctCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  min?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  nullCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
};

export type FieldValueResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FieldValue'] = ResolversParentTypes['FieldValue']> = {
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  value?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
};

export interface JsonScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['JSON'], any> {
  name: 'JSON';
}

export type MetadataResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Metadata'] = ResolversParentTypes['Metadata']> = {
  defaultAggregation?: Resolver<Maybe<ResolversTypes['Aggregation']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  displayFormat?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  family?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isCategorical?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPrimaryKey?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  label?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  labelFields?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  labelFor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  parentName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sqlType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stats?: Resolver<Maybe<ResolversTypes['FieldStats']>, ParentType, ContextType>;
  unit?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type PaginatedComparedFactsResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PaginatedComparedFacts'] = ResolversParentTypes['PaginatedComparedFacts']> = {
  currentPage?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  data?: Resolver<Array<ResolversTypes['ComparedFact']>, ParentType, ContextType>;
  hasNextPage?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalPages?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
};

export type PaginatedFactsResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PaginatedFacts'] = ResolversParentTypes['PaginatedFacts']> = {
  currentPage?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  data?: Resolver<Maybe<Array<Maybe<ResolversTypes['Fact']>>>, ParentType, ContextType>;
  hasNextPage?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  total?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  totalPages?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
};

export type QueryResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = {
  _empty?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  compareAggregatedFacts?: Resolver<ResolversTypes['PaginatedComparedFacts'], ParentType, ContextType, RequireFields<QueryCompareAggregatedFactsArgs, 'aggregation' | 'catalogA' | 'catalogB' | 'groupBy' | 'limit' | 'offset'>>;
  compareFacts?: Resolver<ResolversTypes['PaginatedComparedFacts'], ParentType, ContextType, RequireFields<QueryCompareFactsArgs, 'catalogA' | 'catalogB' | 'joinFields' | 'limit' | 'offset'>>;
  crossDatabaseSelectOptions?: Resolver<Array<ResolversTypes['SelectOption']>, ParentType, ContextType, RequireFields<QueryCrossDatabaseSelectOptionsArgs, 'catalogs' | 'fieldName' | 'limit'>>;
  getAggregatedFacts?: Resolver<Maybe<Array<Maybe<ResolversTypes['AggregatedFact']>>>, ParentType, ContextType, RequireFields<QueryGetAggregatedFactsArgs, 'groupBy' | 'limit' | 'measure' | 'offset'>>;
  getAggregatedFactsWithMetadata?: Resolver<Maybe<ResolversTypes['AggregatedFactsWithMetadata']>, ParentType, ContextType, RequireFields<QueryGetAggregatedFactsWithMetadataArgs, 'groupBy' | 'limit' | 'measure' | 'offset'>>;
  getCatalogSchema?: Resolver<Array<ResolversTypes['Metadata']>, ParentType, ContextType, Partial<QueryGetCatalogSchemaArgs>>;
  getCatalogs?: Resolver<Array<ResolversTypes['Catalog']>, ParentType, ContextType>;
  getDatasetInfo?: Resolver<ResolversTypes['DatasetInfo'], ParentType, ContextType, Partial<QueryGetDatasetInfoArgs>>;
  getFactTable?: Resolver<Maybe<ResolversTypes['PaginatedFacts']>, ParentType, ContextType, RequireFields<QueryGetFactTableArgs, 'limit' | 'offset'>>;
  getFactTableWithMetadata?: Resolver<Maybe<ResolversTypes['DatasetWithMetadata']>, ParentType, ContextType, RequireFields<QueryGetFactTableWithMetadataArgs, 'format' | 'limit' | 'offset'>>;
  getFieldStats?: Resolver<ResolversTypes['FieldStats'], ParentType, ContextType, RequireFields<QueryGetFieldStatsArgs, 'fieldName'>>;
  getFields?: Resolver<Array<ResolversTypes['SelectOption']>, ParentType, ContextType, RequireFields<QueryGetFieldsArgs, 'includeLabelFields'>>;
  getMetaData?: Resolver<Maybe<ResolversTypes['Metadata']>, ParentType, ContextType, RequireFields<QueryGetMetaDataArgs, 'name'>>;
  getSelectOptions?: Resolver<Array<ResolversTypes['SelectOption']>, ParentType, ContextType, RequireFields<QueryGetSelectOptionsArgs, 'fieldName' | 'limit' | 'searchTerm'>>;
  getSelectOptionsTree?: Resolver<ResolversTypes['JSON'], ParentType, ContextType, RequireFields<QueryGetSelectOptionsTreeArgs, 'fieldName'>>;
  getSharedFields?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType, RequireFields<QueryGetSharedFieldsArgs, 'targets'>>;
};

export type SelectOptionResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['SelectOption'] = ResolversParentTypes['SelectOption']> = {
  label?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  value?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type Resolvers<ContextType = GraphQLContext> = {
  AggregatedFact?: AggregatedFactResolvers<ContextType>;
  AggregatedFactsMetadata?: AggregatedFactsMetadataResolvers<ContextType>;
  AggregatedFactsWithMetadata?: AggregatedFactsWithMetadataResolvers<ContextType>;
  AggregationStatistics?: AggregationStatisticsResolvers<ContextType>;
  Catalog?: CatalogResolvers<ContextType>;
  CatalogSchemaInfo?: CatalogSchemaInfoResolvers<ContextType>;
  ComparedFact?: ComparedFactResolvers<ContextType>;
  DatasetInfo?: DatasetInfoResolvers<ContextType>;
  DatasetMetadata?: DatasetMetadataResolvers<ContextType>;
  DatasetWithMetadata?: DatasetWithMetadataResolvers<ContextType>;
  Fact?: FactResolvers<ContextType>;
  FieldStats?: FieldStatsResolvers<ContextType>;
  FieldValue?: FieldValueResolvers<ContextType>;
  JSON?: GraphQLScalarType;
  Metadata?: MetadataResolvers<ContextType>;
  PaginatedComparedFacts?: PaginatedComparedFactsResolvers<ContextType>;
  PaginatedFacts?: PaginatedFactsResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  SelectOption?: SelectOptionResolvers<ContextType>;
};

