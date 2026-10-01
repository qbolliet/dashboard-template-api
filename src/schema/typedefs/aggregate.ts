// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types de la requête d'agrégats ───────────────────────────

/**
 * GraphQL type definitions of the aggregate query.
 *
 * Declares getAggregates — several aggregates over several group columns in
 * one SQL query — with its inputs (GroupByInput and its TimeGrain,
 * AggregateInput, AggregateSortInput), its output format (AggregateFormat)
 * and its result (AggregateResult, GroupColumn, AggregateColumn).
 */
const aggregateTypeDefs: DocumentNode = gql`
  "Truncation applied to a DATE or TIMESTAMP group column (date_trunc). SECOND, MINUTE and HOUR apply to TIMESTAMP columns only; a TIMESTAMP WITH TIME ZONE is truncated in UTC. WEEK starts on Monday (ISO week)"
  enum TimeGrain {
    SECOND
    MINUTE
    HOUR
    DAY
    WEEK
    MONTH
    QUARTER
    YEAR
  }

  "A group column of getAggregates"
  input GroupByInput {
    "Column to group by (must exist in metadata); appears at most once in groupBy"
    field: String!
    "Truncates the values of a DATE or TIMESTAMP column before grouping (e.g. MONTH: one group per month, valued by its first instant). The output column keeps the name of field. Any other column type: BAD_USER_INPUT"
    grain: TimeGrain
  }

  "One requested aggregate: a measure, an operation, an output column name"
  input AggregateInput {
    "Column to aggregate (must exist in metadata)"
    measure: String!
    "Operation, compatible with the type family of the measure: SUM, AVG, MEDIAN on a numeric measure; MIN, MAX on a numeric or temporal one; MODE, COUNT on any (otherwise BAD_USER_INPUT listing the allowed ones). Absent: metadata.defaultAggregation of the measure, then SUM for a numeric measure only; a non-numeric measure without defaultAggregation requires it (COUNT is never implied). COUNT counts the non-NULL values of the measure"
    aggregation: Aggregation
    "Name of the output column, matching ^[a-z_][a-z0-9_]*$. Default: <measure>_<aggregation in lower case> (e.g. value_sum). Every output column name must be unique (group columns, label columns, aliases, row_count)"
    alias: String
  }

  "Sort criterion of getAggregates"
  input AggregateSortInput {
    "An output column: alias of an aggregate, group column, label column (<field>__label) or row_count"
    by: String!
    order: SortOrder = ASC
  }

  "Serialization of the rows of getAggregates"
  enum AggregateFormat {
    "One object per group: {<group columns>, <field>__label, <aliases>, row_count}"
    OBJECTS
    "One array per group, ordered as columns"
    ARRAYS
    "Tidy (long) form: one object per (group, aggregate) — {<group columns>, <field>__label, row_count, measure: <alias>, value} — in the order of the aggregates; OBJECTS melted on the aliases. Group and label columns may then not be named measure or value"
    LONG
  }

  "A group column of an aggregate result"
  type GroupColumn {
    "Name of the column in data (the field of the GroupByInput)"
    name: String!
    "Truncation applied, null for a column grouped by its raw values"
    grain: TimeGrain
    "Column of data holding the label of each group (<name>__label) when the group column is a code with label columns (Metadata.labelFields, default rule: the only one, or the first by alphabetical order), read by ANY_VALUE in the same query; null otherwise (and always with a grain)"
    labelColumn: String
    "Metadata of the column (label, typeFamily, unit…)"
    field: Metadata!
    "[min, max] of the groups of this page, the NULL group ignored: numbers for a numeric column, ISO 8601 strings for a temporal one; null for other types or when the page holds no non-NULL group"
    extent: JSON
  }

  "Description of an aggregate column: everything needed for axes, headers and tooltips"
  type AggregateColumn {
    "Name of the column in data (or value of measure in the LONG format)"
    alias: String!
    "Aggregated column"
    measure: String!
    "Effective operation (argument, else defaultAggregation, else SUM)"
    aggregation: Aggregation!
    "DuckDB type of the result, read from the query: SUM of an integer → HUGEINT, AVG → DOUBLE, COUNT → BIGINT, MIN/MAX/MODE → type of the measure…"
    sqlType: String!
    "Unit of the measure, null for COUNT"
    unit: String
    "d3-format string: the one of the measure, except COUNT (\\",d\\") and AVG/MEDIAN of an integer measure whose format ends with d (two decimals: \\",d\\" → \\",.2f\\")"
    displayFormat: String
    "Full metadata of the measure (label, family, description, lazy stats…)"
    field: Metadata!
    "[min, max] of the values of this page, NULLs ignored: numbers for a numeric aggregate (integers beyond 2^53 compared approximately), ISO 8601 strings for MIN/MAX/MODE of a temporal measure; null otherwise"
    extent: JSON
  }

  "Result of getAggregates"
  type AggregateResult {
    "Group columns, in the requested order (empty: global aggregate)"
    groupBy: [GroupColumn!]!
    "Aggregate columns, in the requested order"
    aggregates: [AggregateColumn!]!
    "Order of the columns of data. OBJECTS and ARRAYS: group columns, label columns, aliases, row_count. LONG: group columns, label columns, row_count, measure, value"
    columns: [String!]!
    "Rows in the requested format. Value types are guaranteed, see the JSON scalar; an aggregate over a group without any non-NULL value is null"
    data: [JSON!]!
    "Number of groups matching the filter, the NULL group included (1 without groupBy). In the LONG format a page holds up to limit × aggregates rows"
    total: Float!
    "Whether groups remain after this page"
    hasNextPage: Boolean!
    "ISO 8601 timestamp of when this result was built"
    generatedAt: String!
  }

  extend type Query {
    "Aggregates of several measures over zero, one or several group columns, in one SQL query. Pagination applies to groups, sorted by sort then by every group column (ascending) as a tie-break"
    getAggregates(
      "Group columns, at most API.AGGREGATES.MAX_GROUP_BY. Empty: global aggregate, a single row (even when no row matches the filter)"
      groupBy: [GroupByInput!] = []
      "Aggregates to compute, 1 to API.AGGREGATES.MAX_AGGREGATES"
      aggregates: [AggregateInput!]!
      "Filter tree (root = group), compiled server-side into a parameterized WHERE clause"
      structuredFilters: FilterNode
      sort: [AggregateSortInput!]
      "Number of groups of the page"
      limit: Int! = 100
      offset: Int! = 0
      format: AggregateFormat = OBJECTS
      "Adds COUNT(*) of each group under row_count"
      includeRowCount: Boolean = true
      catalog: String
      schema: String
    ): AggregateResult!
  }
`;

export { aggregateTypeDefs };
