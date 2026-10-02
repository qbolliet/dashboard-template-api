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

/** Description of an aggregate column: everything needed for axes, headers and tooltips */
export type AggregateColumn = {
  /** Effective operation (argument, else defaultAggregation, else SUM) */
  aggregation: Aggregation;
  /** Name of the column in data (or value of measure in the LONG format) */
  alias: Scalars['String']['output'];
  /** d3-format string: the one of the measure, except COUNT (",d") and AVG/MEDIAN of an integer measure whose format ends with d (two decimals: ",d" → ",.2f") */
  displayFormat?: Maybe<Scalars['String']['output']>;
  /** [min, max] of the values of this page, NULLs ignored: numbers for a numeric aggregate (integers beyond 2^53 compared approximately), ISO 8601 strings for MIN/MAX/MODE of a temporal measure; null otherwise */
  extent?: Maybe<Scalars['JSON']['output']>;
  /** Full metadata of the measure (label, family, description, lazy stats…) */
  field: Metadata;
  /** Aggregated column */
  measure: Scalars['String']['output'];
  /** DuckDB type of the result, read from the query: SUM of an integer → HUGEINT, AVG → DOUBLE, COUNT → BIGINT, MIN/MAX/MODE → type of the measure… */
  sqlType: Scalars['String']['output'];
  /** Unit of the measure, null for COUNT */
  unit?: Maybe<Scalars['String']['output']>;
};

/** Résultat de compareAggregatedFacts */
export type AggregateComparison = {
  /** Agrégats comparés, dans l'ordre demandé. alias est le préfixe des quatre colonnes de data : <alias>_a, <alias>_b, <alias>_delta (b - a) et <alias>_delta_pct ((b - a) / a * 100, null quand a vaut 0 ou null). sqlType est le type de <alias>_a ; extent couvre <alias>_a et <alias>_b */
  aggregates: Array<AggregateColumn>;
  /** Ordre des colonnes de data : colonnes de groupe, colonnes de libellés, puis pour chaque agrégat <alias>_a, <alias>_b, <alias>_delta, <alias>_delta_pct */
  columns: Array<Scalars['String']['output']>;
  /** Une ligne (objet) par groupe commun aux deux datasets. Les colonnes de groupe gardent le type du dataset A ; les libellés sont le COALESCE des deux côtés */
  data: Array<Scalars['JSON']['output']>;
  /** Horodatage ISO 8601 de construction du résultat */
  generatedAt: Scalars['String']['output'];
  /** Colonnes de groupe, dans l'ordre demandé (métadonnées du dataset A ; vide : comparaison globale) */
  groupBy: Array<GroupColumn>;
  /** Indique s'il reste des groupes après cette page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Nombre de groupes communs aux deux datasets (1 sans groupBy) */
  total: Scalars['Float']['output'];
};

/** Serialization of the rows of getAggregates */
export type AggregateFormat =
  /** One array per group, ordered as columns */
  | 'ARRAYS'
  /** Tidy (long) form: one object per (group, aggregate) — {<group columns>, <field>__label, row_count, measure: <alias>, value} — in the order of the aggregates; OBJECTS melted on the aliases. Group and label columns may then not be named measure or value */
  | 'LONG'
  /** One object per group: {<group columns>, <field>__label, <aliases>, row_count} */
  | 'OBJECTS';

/** One requested aggregate: a measure, an operation, an output column name */
export type AggregateInput = {
  /** Operation, compatible with the type family of the measure: SUM, AVG, MEDIAN on a numeric measure; MIN, MAX on a numeric or temporal one; MODE, COUNT on any (otherwise BAD_USER_INPUT listing the allowed ones). Absent: metadata.defaultAggregation of the measure, then SUM for a numeric measure only; a non-numeric measure without defaultAggregation requires it (COUNT is never implied). COUNT counts the non-NULL values of the measure */
  aggregation?: InputMaybe<Aggregation>;
  /** Name of the output column, matching ^[a-z_][a-z0-9_]*$. Default: <measure>_<aggregation in lower case> (e.g. value_sum). Every output column name must be unique (group columns, label columns, aliases, row_count) */
  alias?: InputMaybe<Scalars['String']['input']>;
  /** Column to aggregate (must exist in metadata) */
  measure: Scalars['String']['input'];
};

/** Result of getAggregates */
export type AggregateResult = {
  /** Aggregate columns, in the requested order */
  aggregates: Array<AggregateColumn>;
  /** Order of the columns of data. OBJECTS and ARRAYS: group columns, label columns, aliases, row_count. LONG: group columns, label columns, row_count, measure, value */
  columns: Array<Scalars['String']['output']>;
  /** Rows in the requested format. Value types are guaranteed, see the JSON scalar; an aggregate over a group without any non-NULL value is null */
  data: Array<Scalars['JSON']['output']>;
  /** ISO 8601 timestamp of when this result was built */
  generatedAt: Scalars['String']['output'];
  /** Group columns, in the requested order (empty: global aggregate) */
  groupBy: Array<GroupColumn>;
  /** Whether groups remain after this page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Number of groups matching the filter, the NULL group included (1 without groupBy). In the LONG format a page holds up to limit × aggregates rows */
  total: Scalars['Float']['output'];
};

/** Sort criterion of getAggregates */
export type AggregateSortInput = {
  /** An output column: alias of an aggregate, group column, label column (<field>__label) or row_count */
  by: Scalars['String']['input'];
  order?: InputMaybe<SortOrder>;
};

export type Aggregation =
  | 'AVG'
  | 'COUNT'
  | 'MAX'
  | 'MEDIAN'
  | 'MIN'
  | 'MODE'
  | 'SUM';

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

/** Comparaison d'une mesure agrégée entre deux datasets pour une clé commune */
export type ComparedFact = {
  /** Différence absolue (valueB - valueA) */
  delta?: Maybe<Scalars['Float']['output']>;
  /** Différence relative en % ((valueB - valueA) / valueA * 100) ; null quand valueA vaut 0 ou null */
  deltaPercent?: Maybe<Scalars['Float']['output']>;
  /** Valeur de la clé commune (libellé porté par la colonne de jointure ; valeurs jointes par '::' sur plusieurs champs) */
  key: Scalars['String']['output'];
  /** Libellé de la clé quand la comparaison porte sur un seul champ doté de colonnes de libellés (règle par défaut, ANY_VALUE de chaque côté puis COALESCE) ; null sinon */
  keyLabel?: Maybe<Scalars['String']['output']>;
  /** Mesure agrégée dans le dataset A */
  valueA?: Maybe<Scalars['Float']['output']>;
  /** Mesure agrégée dans le dataset B */
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
  /** Bounds of the columns of this page (not of the whole dataset), keyed by column name: [min, max] as numbers for numeric columns (integers beyond 2^53, serialized as strings, are compared as numbers, so their bound is approximate), [min, max] as ISO 8601 strings for date and timestamp columns (chronological comparison). NULLs are ignored; a column with no value has no entry. Global bounds of a column: Metadata.stats */
  extents?: Maybe<Scalars['JSON']['output']>;
  /** ISO 8601 timestamp of when this query was executed */
  generatedAt: Scalars['String']['output'];
  /** Whether there are more pages available */
  hasNextPage?: Maybe<Scalars['Boolean']['output']>;
  /** Total number of records matching the query */
  total?: Maybe<Scalars['Float']['output']>;
  /** Total number of pages */
  totalPages?: Maybe<Scalars['Float']['output']>;
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
  distinctCount: Scalars['Float']['output'];
  /** Max de la colonne, mêmes formes que min, null si colonne vide */
  max?: Maybe<Scalars['JSON']['output']>;
  /** Min de la colonne (nombre ou date ISO), null si colonne vide. Sérialisation du scalaire JSON : entier au-delà de 2^53 en chaîne décimale exacte, DATE en YYYY-MM-DD, TIMESTAMP en ISO 8601. Sur une colonne texte ou booléenne, le min est calculé aussi (ordre lexical ; false < true) */
  min?: Maybe<Scalars['JSON']['output']>;
  /** Nombre de valeurs NULL */
  nullCount: Scalars['Float']['output'];
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

/** Filter operation. The allowed set depends on the column's SQL type, read server-side from metadata.sqlType, and is exposed per column as Metadata.filterOperations (route on Metadata.typeFamily, offer Metadata.filterOperations — never copy the table client-side). Numeric: comparisons, BETWEEN, IN, IS_NULL; DATE/TIMESTAMP: EQ, NEQ, BEFORE/AFTER family, BETWEEN, IN, IS_NULL; VARCHAR: EQ, NEQ, LIKE and ILIKE families, MATCHES, IN, IS_NULL; BOOLEAN: EQ, NEQ, IS_TRUE family, IS_NULL; any other type (TIME, INTERVAL, BLOB, nested types…): IS_NULL and IS_NOT_NULL only */
export type FilterOperation =
  | 'AFTER'
  /** Date comparisons (strict, then inclusive) */
  | 'BEFORE'
  /** Range, bounds included (numeric, date) — value {min, max} */
  | 'BETWEEN'
  /** Text matching (LIKE); wildcards % and _ in the value are escaped */
  | 'CONTAINS'
  | 'ENDS'
  /** Equality / inequality (numeric, date, text and boolean columns) */
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
  /** Value-less operations, allowed on every column whatever its type */
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

/** A group column of getAggregates */
export type GroupByInput = {
  /** Column to group by (must exist in metadata); appears at most once in groupBy */
  field: Scalars['String']['input'];
  /** Truncates the values of a DATE or TIMESTAMP column before grouping (e.g. MONTH: one group per month, valued by its first instant). The output column keeps the name of field. Any other column type: BAD_USER_INPUT */
  grain?: InputMaybe<TimeGrain>;
};

/** A group column of an aggregate result */
export type GroupColumn = {
  /** [min, max] of the groups of this page, the NULL group ignored: numbers for a numeric column, ISO 8601 strings for a temporal one; null for other types or when the page holds no non-NULL group */
  extent?: Maybe<Scalars['JSON']['output']>;
  /** Metadata of the column (label, typeFamily, unit…) */
  field: Metadata;
  /** Truncation applied, null for a column grouped by its raw values */
  grain?: Maybe<TimeGrain>;
  /** Column of data holding the label of each group (<name>__label) when the group column is a code with label columns (Metadata.labelFields, default rule: the only one, or the first by alphabetical order), read by ANY_VALUE in the same query; null otherwise (and always with a grain) */
  labelColumn?: Maybe<Scalars['String']['output']>;
  /** Name of the column in data (the field of the GroupByInput) */
  name: Scalars['String']['output'];
};

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
  /** Opérations de filtre acceptées sur cette colonne : exactement l'ensemble que structuredFilters valide, dans un ordre stable. Une colonne catégorielle garde les opérations de son type (le widget se choisit par isCategorical) */
  filterOperations: Array<FilterOperation>;
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
  /** Type SQL DuckDB (BIGINT, DOUBLE, VARCHAR, …) tel qu'écrit dans la base ; pour router l'interface, préférer typeFamily et filterOperations */
  sqlType: Scalars['String']['output'];
  /** Statistiques de la colonne sur toute la table des faits (bornes de sliders, datepickers, axes). Calculées à la demande, seulement quand ce champ est sélectionné : une requête SQL par colonne. Pour des bornes après filtrage : getFieldStats */
  stats?: Maybe<FieldStats>;
  /** Famille de type dérivée de sqlType par la règle du serveur : pilote le choix du widget (slider entier ou continu, sélecteur de date ou de date-heure…) et du graphique */
  typeFamily: TypeFamily;
  /** Suffixe d'axe / tooltip (« € », « % », « MW ») */
  unit?: Maybe<Scalars['String']['output']>;
};

/** Résultat paginé de compareFacts */
export type PaginatedComparedFacts = {
  /** Agrégation appliquée à la mesure de chaque côté */
  aggregation: Aggregation;
  currentPage: Scalars['Int']['output'];
  /** Une ligne par clé commune aux deux datasets */
  data: Array<ComparedFact>;
  hasNextPage: Scalars['Boolean']['output'];
  /** Mesure comparée */
  measure: Scalars['String']['output'];
  /** Nombre de clés communes */
  total: Scalars['Float']['output'];
  totalPages: Scalars['Float']['output'];
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
  total?: Maybe<Scalars['Float']['output']>;
  /** Total number of pages */
  totalPages?: Maybe<Scalars['Float']['output']>;
};

export type Query = {
  _empty?: Maybe<Scalars['String']['output']>;
  /** Compare plusieurs agrégats de deux datasets (catalogue + schéma) sur des colonnes de groupe communes, dans la forme de getAggregates. Chaque côté est agrégé par la même requête que getAggregates, puis les deux côtés sont joints sur les colonnes de groupe (alignées en VARCHAR) ; un groupe absent d'un côté est écarté. Pagination sur les groupes, triés par sort puis par chaque colonne de groupe (ordre croissant) */
  compareAggregatedFacts: AggregateComparison;
  /** Compare une mesure de deux datasets (catalogue + schéma) sur des champs de jointure communs. Chaque côté est d'abord agrégé par les champs de jointure (une ligne par clé), puis les deux côtés sont joints sur ces champs, alignés en VARCHAR pour absorber une différence de type entre catalogues ; une clé absente d'un côté est écartée. */
  compareFacts: PaginatedComparedFacts;
  /** Retourne les options de sélection communes à plusieurs datasets (intersection sur les labels pour les champs catégoriels) */
  crossDatabaseSelectOptions: Array<SelectOption>;
  /** Aggregates of several measures over zero, one or several group columns, in one SQL query. Pagination applies to groups, sorted by sort then by every group column (ascending) as a tie-break */
  getAggregates: AggregateResult;
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
  aggregates: Array<AggregateInput>;
  catalogA: Scalars['String']['input'];
  catalogB: Scalars['String']['input'];
  groupBy?: InputMaybe<Array<GroupByInput>>;
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  schemaA?: InputMaybe<Scalars['String']['input']>;
  schemaB?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Array<AggregateSortInput>>;
};


export type QueryCompareFactsArgs = {
  aggregation?: InputMaybe<Aggregation>;
  catalogA: Scalars['String']['input'];
  catalogB: Scalars['String']['input'];
  joinFields: Array<Scalars['String']['input']>;
  limit?: Scalars['Int']['input'];
  measure?: InputMaybe<Scalars['String']['input']>;
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


export type QueryGetAggregatesArgs = {
  aggregates: Array<AggregateInput>;
  catalog?: InputMaybe<Scalars['String']['input']>;
  format?: InputMaybe<AggregateFormat>;
  groupBy?: InputMaybe<Array<GroupByInput>>;
  includeRowCount?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  schema?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Array<AggregateSortInput>>;
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

/** Truncation applied to a DATE or TIMESTAMP group column (date_trunc). SECOND, MINUTE and HOUR apply to TIMESTAMP columns only; a TIMESTAMP WITH TIME ZONE is truncated in UTC. WEEK starts on Monday (ISO week) */
export type TimeGrain =
  | 'DAY'
  | 'HOUR'
  | 'MINUTE'
  | 'MONTH'
  | 'QUARTER'
  | 'SECOND'
  | 'WEEK'
  | 'YEAR';

/**
 * Famille de type d'une colonne, dérivée de sqlType par la règle du serveur (celle qui valide
 * les filtres) : un client route ses widgets sur cette valeur au lieu de recopier une table des
 * types SQL. Correspondance complète (type normalisé : casse et espaces ignorés) :
 * INTEGER = TINYINT, SMALLINT, INTEGER, BIGINT, HUGEINT, UTINYINT, USMALLINT, UINTEGER, UBIGINT,
 * UHUGEINT ; NUMBER = FLOAT, DOUBLE, DECIMAL, DECIMAL(p), DECIMAL(p,s) (p ≤ 38, s ≤ p) ;
 * DATE = DATE ; TIMESTAMP = TIMESTAMP, TIMESTAMP_S, TIMESTAMP_MS, TIMESTAMP_NS,
 * TIMESTAMP WITH TIME ZONE, TIMESTAMPTZ ; TEXT = VARCHAR ; BOOLEAN = BOOLEAN ;
 * OTHER = tout autre type (TIME, INTERVAL, BLOB, UUID, types imbriqués…).
 */
export type TypeFamily =
  /** Booléen (BOOLEAN) */
  | 'BOOLEAN'
  /** Date sans heure (DATE) : sélecteur de date */
  | 'DATE'
  /** Entier signé ou non signé (TINYINT … UHUGEINT) : slider au pas entier, format sans décimale */
  | 'INTEGER'
  /** Flottant ou décimal (FLOAT, DOUBLE, DECIMAL) : mesure continue */
  | 'NUMBER'
  /** Tout autre type (TIME, INTERVAL, BLOB, UUID, types imbriqués…) : seuls IS_NULL et IS_NOT_NULL s'y appliquent */
  | 'OTHER'
  /** Texte (VARCHAR) */
  | 'TEXT'
  /** Date-heure, avec ou sans fuseau (TIMESTAMP et variantes) : sélecteur de date-heure */
  | 'TIMESTAMP';



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
  AggregateColumn: ResolverTypeWrapper<Omit<AggregateColumn, 'field'> & { field: ResolversTypes['Metadata'] }>;
  AggregateComparison: ResolverTypeWrapper<Omit<AggregateComparison, 'aggregates' | 'groupBy'> & { aggregates: Array<ResolversTypes['AggregateColumn']>, groupBy: Array<ResolversTypes['GroupColumn']> }>;
  AggregateFormat: AggregateFormat;
  AggregateInput: AggregateInput;
  AggregateResult: ResolverTypeWrapper<Omit<AggregateResult, 'aggregates' | 'groupBy'> & { aggregates: Array<ResolversTypes['AggregateColumn']>, groupBy: Array<ResolversTypes['GroupColumn']> }>;
  AggregateSortInput: AggregateSortInput;
  Aggregation: Aggregation;
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
  GroupByInput: GroupByInput;
  GroupColumn: ResolverTypeWrapper<Omit<GroupColumn, 'field'> & { field: ResolversTypes['Metadata'] }>;
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
  TimeGrain: TimeGrain;
  TypeFamily: TypeFamily;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  AggregateColumn: Omit<AggregateColumn, 'field'> & { field: ResolversParentTypes['Metadata'] };
  AggregateComparison: Omit<AggregateComparison, 'aggregates' | 'groupBy'> & { aggregates: Array<ResolversParentTypes['AggregateColumn']>, groupBy: Array<ResolversParentTypes['GroupColumn']> };
  AggregateInput: AggregateInput;
  AggregateResult: Omit<AggregateResult, 'aggregates' | 'groupBy'> & { aggregates: Array<ResolversParentTypes['AggregateColumn']>, groupBy: Array<ResolversParentTypes['GroupColumn']> };
  AggregateSortInput: AggregateSortInput;
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
  GroupByInput: GroupByInput;
  GroupColumn: Omit<GroupColumn, 'field'> & { field: ResolversParentTypes['Metadata'] };
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

export type AggregateColumnResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AggregateColumn'] = ResolversParentTypes['AggregateColumn']> = {
  aggregation?: Resolver<ResolversTypes['Aggregation'], ParentType, ContextType>;
  alias?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  displayFormat?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  extent?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  field?: Resolver<ResolversTypes['Metadata'], ParentType, ContextType>;
  measure?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sqlType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  unit?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type AggregateComparisonResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AggregateComparison'] = ResolversParentTypes['AggregateComparison']> = {
  aggregates?: Resolver<Array<ResolversTypes['AggregateColumn']>, ParentType, ContextType>;
  columns?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  data?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  generatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  groupBy?: Resolver<Array<ResolversTypes['GroupColumn']>, ParentType, ContextType>;
  hasNextPage?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
};

export type AggregateResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AggregateResult'] = ResolversParentTypes['AggregateResult']> = {
  aggregates?: Resolver<Array<ResolversTypes['AggregateColumn']>, ParentType, ContextType>;
  columns?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  data?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  generatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  groupBy?: Resolver<Array<ResolversTypes['GroupColumn']>, ParentType, ContextType>;
  hasNextPage?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
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
  total?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  totalPages?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
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
  distinctCount?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  max?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  min?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  nullCount?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
};

export type FieldValueResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FieldValue'] = ResolversParentTypes['FieldValue']> = {
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  value?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
};

export type GroupColumnResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GroupColumn'] = ResolversParentTypes['GroupColumn']> = {
  extent?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  field?: Resolver<ResolversTypes['Metadata'], ParentType, ContextType>;
  grain?: Resolver<Maybe<ResolversTypes['TimeGrain']>, ParentType, ContextType>;
  labelColumn?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export interface JsonScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['JSON'], any> {
  name: 'JSON';
}

export type MetadataResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Metadata'] = ResolversParentTypes['Metadata']> = {
  defaultAggregation?: Resolver<Maybe<ResolversTypes['Aggregation']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  displayFormat?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  family?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  filterOperations?: Resolver<Array<ResolversTypes['FilterOperation']>, ParentType, ContextType>;
  isCategorical?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPrimaryKey?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  label?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  labelFields?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  labelFor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  parentName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sqlType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stats?: Resolver<Maybe<ResolversTypes['FieldStats']>, ParentType, ContextType>;
  typeFamily?: Resolver<ResolversTypes['TypeFamily'], ParentType, ContextType>;
  unit?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type PaginatedComparedFactsResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PaginatedComparedFacts'] = ResolversParentTypes['PaginatedComparedFacts']> = {
  aggregation?: Resolver<ResolversTypes['Aggregation'], ParentType, ContextType>;
  currentPage?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  data?: Resolver<Array<ResolversTypes['ComparedFact']>, ParentType, ContextType>;
  hasNextPage?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  measure?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  totalPages?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
};

export type PaginatedFactsResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PaginatedFacts'] = ResolversParentTypes['PaginatedFacts']> = {
  currentPage?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  data?: Resolver<Maybe<Array<Maybe<ResolversTypes['Fact']>>>, ParentType, ContextType>;
  hasNextPage?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  total?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  totalPages?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
};

export type QueryResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = {
  _empty?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  compareAggregatedFacts?: Resolver<ResolversTypes['AggregateComparison'], ParentType, ContextType, RequireFields<QueryCompareAggregatedFactsArgs, 'aggregates' | 'catalogA' | 'catalogB' | 'groupBy' | 'limit' | 'offset'>>;
  compareFacts?: Resolver<ResolversTypes['PaginatedComparedFacts'], ParentType, ContextType, RequireFields<QueryCompareFactsArgs, 'catalogA' | 'catalogB' | 'joinFields' | 'limit' | 'offset'>>;
  crossDatabaseSelectOptions?: Resolver<Array<ResolversTypes['SelectOption']>, ParentType, ContextType, RequireFields<QueryCrossDatabaseSelectOptionsArgs, 'catalogs' | 'fieldName' | 'limit'>>;
  getAggregates?: Resolver<ResolversTypes['AggregateResult'], ParentType, ContextType, RequireFields<QueryGetAggregatesArgs, 'aggregates' | 'format' | 'groupBy' | 'includeRowCount' | 'limit' | 'offset'>>;
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
  AggregateColumn?: AggregateColumnResolvers<ContextType>;
  AggregateComparison?: AggregateComparisonResolvers<ContextType>;
  AggregateResult?: AggregateResultResolvers<ContextType>;
  Catalog?: CatalogResolvers<ContextType>;
  CatalogSchemaInfo?: CatalogSchemaInfoResolvers<ContextType>;
  ComparedFact?: ComparedFactResolvers<ContextType>;
  DatasetInfo?: DatasetInfoResolvers<ContextType>;
  DatasetMetadata?: DatasetMetadataResolvers<ContextType>;
  DatasetWithMetadata?: DatasetWithMetadataResolvers<ContextType>;
  Fact?: FactResolvers<ContextType>;
  FieldStats?: FieldStatsResolvers<ContextType>;
  FieldValue?: FieldValueResolvers<ContextType>;
  GroupColumn?: GroupColumnResolvers<ContextType>;
  JSON?: GraphQLScalarType;
  Metadata?: MetadataResolvers<ContextType>;
  PaginatedComparedFacts?: PaginatedComparedFactsResolvers<ContextType>;
  PaginatedFacts?: PaginatedFactsResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  SelectOption?: SelectOptionResolvers<ContextType>;
};

