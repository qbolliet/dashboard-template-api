---
title: Queries Reference
sidebar_position: 2
---

# Queries Reference

All operations are GraphQL queries (read-only). Send them to `POST /graphql` with `Content-Type: application/json`.

## Common input types

### FilterNode (filter tree)

Filters are expressed as a **tree** of criteria, mirroring the frontend
`MultiCriterionMenu` (`buildTree`). The server compiles it into a
**parameterized** SQL `WHERE` clause: values are never interpolated, and column
types are read from the `metadata` table (`sql_type`), never from the client.

```graphql
enum FilterConnector {
  AND
  OR
  AND_NOT
  OR_NOT
  XOR
  XNOR
  NAND
  NOR
}

enum FilterOperation {
  EQ
  NEQ
  GT
  GTE
  LT
  LTE
  BETWEEN
  NOT_BETWEEN
  IN
  NOT_IN
  BEFORE
  AFTER
  ON_OR_BEFORE
  ON_OR_AFTER
  CONTAINS
  NOT_CONTAINS
  STARTS
  NOT_STARTS
  ENDS
  NOT_ENDS
  IEQ
  ICONTAINS
  ISTARTS
  IENDS
  MATCHES
  IS_NULL
  IS_NOT_NULL
  IS_TRUE
  IS_FALSE
  IS_NOT_TRUE
  IS_NOT_FALSE
}

input FilterCriterion {
  variable: String! # column name (must exist in metadata)
  operation: FilterOperation!
  value: JSON # see "Value shapes" below
}

input FilterNode {
  connector: FilterConnector # connector with the PREVIOUS node of the group (ignored for the first, default AND)
  negate: Boolean = false # NOT on this node: the leaf predicate, or the whole group
  criterion: FilterCriterion # leaf …
  children: [FilterNode!] # … or group — exactly one of the two
}
```

Rules:

- The root node is a **non-empty group** (`children`). To apply no filter, omit
  `structuredFilters` (an empty group is rejected).
- Each node sets **exactly one** of `criterion` / `children`; groups cannot be empty.
- Children are combined left to right with their connector; sub-groups are
  parenthesized (standard SQL precedence applies inside a group: `NOT`, then
  `AND`, then `OR`). `AND`, `OR`, `AND_NOT` and `OR_NOT` are appended flat and
  keep that precedence; `XOR`, `XNOR`, `NAND` and `NOR` have no SQL keyword in
  DuckDB, so they are built from `NOT` / `AND` / `OR` (or boolean (in)equality)
  and take **everything on their left** as a single, parenthesized operand.
- `negate: true` wraps the node in `NOT (…)`: on a leaf it negates that predicate,
  on a group the whole parenthesized group. Combined with `AND` / `OR` this covers
  « AND NOT », « OR NOT » and `NOT (… OR …)`, so no extra connector is needed.
- Bounds (`config/security.yaml`, `SECURITY.FILTER_TREE`): group nesting depth
  ≤ `MAX_DEPTH` (5, root = 0), criteria ≤ `MAX_CRITERIA` (50), IN list ≤
  `MAX_IN_VALUES` (1000), regex length ≤ `MAX_PATTERN_LENGTH` (200).

Connectors:

| Connector | SQL built           | Binding                                    |
| --------- | ------------------- | ------------------------------------------ |
| `AND`     | `a AND b`           | flat, SQL precedence                       |
| `OR`      | `a OR b`            | flat, SQL precedence                       |
| `AND_NOT` | `a AND NOT (b)`     | flat, SQL precedence                       |
| `OR_NOT`  | `a OR NOT (b)`      | flat, SQL precedence                       |
| `XOR`     | `(a) <> (b)`        | everything on the left is the left operand |
| `XNOR`    | `(a) = (b)`         | everything on the left is the left operand |
| `NAND`    | `NOT ((a) AND (b))` | everything on the left is the left operand |
| `NOR`     | `NOT ((a) OR (b))`  | everything on the left is the left operand |

All of them follow SQL three-valued logic: a `NULL` operand yields `NULL` and the
row is not selected — except `NOR`, which is true as soon as both sides are false.
`AND_NOT` / `OR_NOT` are exactly `AND` / `OR` on a node carrying `negate: true`.

Allowed operations per column type family:

| Family  | SQL types                                                                                                                                                   | Operations                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| numeric | `TINYINT` `SMALLINT` `INTEGER` `BIGINT` `HUGEINT` `UTINYINT` `USMALLINT` `UINTEGER` `UBIGINT` `UHUGEINT` `FLOAT` `DOUBLE` `DECIMAL` `DECIMAL(p,s)` (p ≤ 38) | `EQ NEQ GT GTE LT LTE BETWEEN NOT_BETWEEN IN NOT_IN IS_NULL IS_NOT_NULL`                                                         |
| date    | `DATE` `TIMESTAMP` (`_S` `_MS` `_NS`, `WITH TIME ZONE`)                                                                                                     | `EQ NEQ BEFORE AFTER ON_OR_BEFORE ON_OR_AFTER BETWEEN NOT_BETWEEN IN NOT_IN IS_NULL IS_NOT_NULL`                                 |
| text    | `VARCHAR`                                                                                                                                                   | `EQ NEQ IEQ CONTAINS NOT_CONTAINS ICONTAINS STARTS NOT_STARTS ISTARTS ENDS NOT_ENDS IENDS MATCHES IN NOT_IN IS_NULL IS_NOT_NULL` |
| boolean | `BOOLEAN`                                                                                                                                                   | `EQ NEQ IS_TRUE IS_FALSE IS_NOT_TRUE IS_NOT_FALSE IS_NULL IS_NOT_NULL`                                                           |
| other   | `TIME` `INTERVAL` `BLOB` and every other type (nested, `UUID`…)                                                                                             | `IS_NULL IS_NOT_NULL`                                                                                                            |

The database declares a decimal column as a bare `DECIMAL` in `metadata.sql_type`
as readily as `DECIMAL(p,s)`; both are numeric. A column of the `other` family is
listed, projected, sorted and described (`stats`, `getFields`) like any other;
only `IS_NULL` / `IS_NOT_NULL` filter it, and any other operation is refused with an
error naming its type. `SUM`, `AVG` and `MEDIAN` are refused on it; `COUNT` and
`MODE` are allowed.

#### Building a filter UI: `typeFamily` and `filterOperations`

Do not copy the table above into a client: every `Metadata` exposes it per column,
computed by the same server rule that validates the filters.

- `typeFamily` (`TypeFamily` enum) picks the widget and the chart: `INTEGER`
  (integer slider step, no decimals), `NUMBER` (continuous measure), `DATE` (date
  picker), `TIMESTAMP` (date-time picker), `TEXT`, `BOOLEAN`, `OTHER`.
- `filterOperations` lists the operations `structuredFilters` accepts on the
  column, exactly: every listed operation is accepted, any other one is a
  `BAD_USER_INPUT`. Offer these, in this order, in the operator menu.
- A categorical column (`isCategorical`) keeps the operations of its type; route it
  to a menu fed by `getSelectOptions` first, then fall back on `typeFamily`.

| `typeFamily` | SQL types                                                                                                | `filterOperations`      |
| ------------ | -------------------------------------------------------------------------------------------------------- | ----------------------- |
| `INTEGER`    | `TINYINT` `SMALLINT` `INTEGER` `BIGINT` `HUGEINT` `UTINYINT` `USMALLINT` `UINTEGER` `UBIGINT` `UHUGEINT` | numeric row above       |
| `NUMBER`     | `FLOAT` `DOUBLE` `DECIMAL` `DECIMAL(p)` `DECIMAL(p,s)`                                                   | numeric row above       |
| `DATE`       | `DATE`                                                                                                   | date row above          |
| `TIMESTAMP`  | `TIMESTAMP` `TIMESTAMP_S` `TIMESTAMP_MS` `TIMESTAMP_NS` `TIMESTAMP WITH TIME ZONE` `TIMESTAMPTZ`         | date row above          |
| `TEXT`       | `VARCHAR`                                                                                                | text row above          |
| `BOOLEAN`    | `BOOLEAN`                                                                                                | boolean row above       |
| `OTHER`      | everything else                                                                                          | `IS_NULL` `IS_NOT_NULL` |

```graphql
query FilterableColumns($schema: String) {
  getCatalogSchema(schema: $schema) {
    name
    label
    isCategorical
    typeFamily
    filterOperations
  }
}
```

Both fields cost no query: they are derived from `sqlType` on every path returning a
`Metadata` (`getCatalogSchema`, `getCatalogs { schemas { fields } }`,
`getFactTableWithMetadata { fields }`, `groupByFieldInfo`, `measureFieldInfo`,
`getMetaData`).

The `I*` operations (`IEQ`, `ICONTAINS`, `ISTARTS`, `IENDS`) are the case-insensitive
twins of their `LIKE` counterparts (SQL `ILIKE`); `IEQ` adds no wildcard, so it is a
case-insensitive equality. `MATCHES` compiles to DuckDB's `regexp_matches` (RE2
syntax, e.g. `(?i)` for case-insensitivity, `(?P<name>…)` for named groups);
lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`), atomic groups `(?>`, `(?<name>…)` and
back-references (`\1`, `\k<name>`) are rejected with `BAD_USER_INPUT` naming the
construct, and any other RE2 syntax error comes back as `BAD_USER_INPUT` too.
Patterns are capped at `MAX_PATTERN_LENGTH` (200 characters). On a nullable
column, `IS_NOT_TRUE` / `IS_NOT_FALSE` also match `NULL`, unlike `NEQ`.

Value shapes:

- comparisons (`EQ`, `GT`, `BEFORE`, `CONTAINS`…): a scalar — number (or numeric
  string for integers beyond 2^53), ISO 8601 string for dates (`YYYY-MM-DD` for
  `DATE`), string for text, `true`/`false` for booleans;
- `IN` / `NOT_IN`: a non-empty array of scalars;
- `BETWEEN` / `NOT_BETWEEN`: `{ "min": …, "max": … }` (bounds included);
- `IS_NULL`, `IS_NOT_NULL`, `IS_TRUE`, `IS_FALSE`, `IS_NOT_TRUE`, `IS_NOT_FALSE`: no value.

All `LIKE` / `ILIKE` operations match the value literally (`%` and `_` are escaped).
Any invalid tree, unknown column, incompatible operation or malformed value is
rejected with a `BAD_USER_INPUT` error naming the column, its type and the
allowed operations.

Column names are not restricted to `[A-Za-z0-9_]`: any column declared in the
`metadata` table (`"taux chômage"`, `"Année"`, `"zone d'emploi"`) can be used in
`fields`, `sort`, `groupBy`, `measure`, filter variables and the export. Every
such name is checked against `metadata` — an unknown one is a `BAD_USER_INPUT`
error listing all offending names — then quoted in the SQL.

### Pagination and errors

`limit` must be between 1 and `API.PAGINATION.MAX_LIMIT` (1000) and `offset`
between 0 and `MAX_OFFSET` (10000), on every paginated query (fact, aggregate,
comparison and select-option queries); anything else is rejected with
`BAD_USER_INPUT` before any database work. No error is ever turned into a silent
`null`: an input the database refuses (type mismatch such as `SUM` on a `VARCHAR`
measure, invalid regex) is a `BAD_USER_INPUT`, and a server-side failure is an
`INTERNAL_SERVER_ERROR` carrying an `errorId` to quote when reporting it.

Client errors keep their message in production too — `BAD_USER_INPUT` (unknown
column or catalog, limit out of bounds…), `SCHEMA_VERSION_UNSUPPORTED`,
`QUERY_COMPLEXITY_EXCEEDED`, `GRAPHQL_VALIDATION_FAILED`, `GRAPHQL_PARSE_FAILED`,
`OPERATION_TYPE_NOT_ALLOWED`, `CROSS_DATABASE_DISABLED`. Only
`INTERNAL_SERVER_ERROR` (and any unexpected code) is reduced in production to
`An error occurred` with its `code` and `errorId`. Every error carries an
`errorId`.

Example — `kind = 1 AND NOT (country = 1 OR country = 2)`:

```graphql
structuredFilters: {
  children: [
    { criterion: { variable: "kind", operation: EQ, value: 1 } }
    {
      connector: AND
      negate: true
      children: [
        { criterion: { variable: "country", operation: EQ, value: 1 } }
        { connector: OR, criterion: { variable: "country", operation: EQ, value: 2 } }
      ]
    }
  ]
}
```

### SortInput

```graphql
input SortInput {
  field: String!
  order: SortOrder # ASC (default) | DESC
}
```

Without `sort`, fact rows come in the physical order of the table
(`dataset_metadata.cluster_by`, else the primary keys), so pages are disjoint. A
schema with neither — no primary key, hence no `cluster_by` — is ordered by **every
column**, in table order (`ORDER BY ALL`): the pages stay exact, at the cost of
sorting the whole table for each page, and the API warns once per schema in its
logs. An explicit `sort` is completed with the primary keys, or with the other
columns when there is none, so ties never make pages overlap. The export follows
the same rule.

### Aggregation enum

`SUM` | `AVG` | `MAX` | `MIN` | `COUNT` | `MEDIAN` | `MODE`

---

## Fact queries

### `getFactTable`

Paginated fact rows, each split into its coordinates and its measures.

```graphql
getFactTable(
  fields: [String!]            # columns to return (omit for all)
  structuredFilters: FilterNode # filter tree (root = group)
  limit: Int! = 100
  offset: Int! = 0
  sort: [SortInput!]
  catalog: String              # catalog ID (falls back to DEFAULT_CATALOG)
  schema: String               # schema within the catalog (falls back to its default)
): PaginatedFacts
```

Returns `PaginatedFacts`:

```graphql
type PaginatedFacts {
  data: [Fact]
  total: Int
  hasNextPage: Boolean
  currentPage: Int
  totalPages: Int
}

type Fact {
  keys: [FieldValue!]! # every column with is_primary_key = true, NULL included
  measures: [FieldValue!]! # every column with is_primary_key = false
}

type FieldValue {
  name: String!
  value: JSON # original type preserved; null when the column is NULL
}
```

The fact table stores labels directly, so a key needs no resolution:
`country` already holds `"France"`. A NULL key is kept rather than omitted —
a row whose `commune` level of a column hierarchy is absent still exposes
`{ name: "commune", value: null }`, so every row has the same shape.

---

### `getFactTableWithMetadata`

D3-optimised dataset with column metadata and extents.

```graphql
getFactTableWithMetadata(
  fields: [String!]
  structuredFilters: FilterNode
  limit: Int! = 100
  offset: Int! = 0
  sort: [SortInput!]
  catalog: String
  schema: String
  format: DataFormat = OBJECTS   # OBJECTS | ARRAYS
): DatasetWithMetadata
```

`format: OBJECTS` returns `[{ col: val, … }]` — compatible with D3 and DataTable.  
`format: ARRAYS` returns `[[val1, val2, …]]` — more compact, suited for AG Grid / TanStack Table.

The response carries what a `<Chart>` or a `DataTable` needs to configure itself,
with no second request and no sampling of the data:

- `columns` — the returned column names, in order.
- `fields` — the `Metadata` of each returned column, **aligned on `columns`** (same
  names, same order, also with `fields:` projection and `format: ARRAYS`): `typeFamily`
  (axis type, numeric alignment), `filterOperations` (column filter menu), `sqlType`,
  `label` (header), `unit` (axis suffix), `displayFormat` (d3-format),
  `family`, `labelFields`… They come from the already-loaded metadata, without any
  extra query. A column with no row in the `metadata` table fails the request with an
  explicit error instead of leaving a hole.
- `metadata.extents` — min/max of the columns **of the page** (not of the whole
  dataset; the global bounds of a column are `Metadata.stats`): `[min, max]` as numbers
  for numeric columns, as ISO 8601 strings for date and timestamp columns (chronological
  comparison). NULLs are ignored; a column with no value, and text or boolean columns,
  have no entry. Integers beyond 2^53 (serialized as strings, see below) are compared as
  numbers, so their bound is approximate at that magnitude.

```graphql
query {
  getFactTableWithMetadata(fields: ["date", "value"], limit: 100) {
    columns
    fields {
      name
      label
      typeFamily
      unit
      displayFormat
    }
    data
    metadata {
      extents
    }
  }
}
```

#### Value types

Every JSON path — `OBJECTS`, `ARRAYS`, `getFactTable`, aggregates, `compare*` —
serializes the values with one converter, driven by the DuckDB column type:

| DuckDB type                      | JSON value                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `TINYINT` … `UBIGINT`, `HUGEINT` | number when `Number.isSafeInteger` holds, **exact decimal string beyond** (> 2^53) |
| `DECIMAL`, `FLOAT`, `DOUBLE`     | number (`NaN`, `±Infinity` → `null`)                                               |
| `DATE`                           | `"YYYY-MM-DD"`                                                                     |
| `TIMESTAMP`                      | `"YYYY-MM-DDTHH:mm:ss[.sss]"` (ISO 8601, `T` separator)                            |
| `TIMESTAMP WITH TIME ZONE`       | same, in UTC, with a `Z` suffix                                                    |
| `BOOLEAN`                        | boolean                                                                            |
| `NULL`                           | `null`                                                                             |

A client therefore tests `typeof value === "string"` on an integer column to detect a
value beyond 2^53 and hands it to `BigInt(value)`; any other integer is a number.

---

## Aggregate query

### `getAggregates`

Several aggregates of several measures, over zero, one or several group columns,
in **one SQL query**. This is the query behind charts, KPI tiles and summary
tables: the API aggregates the whole filtered dataset, not just the loaded page,
and it applies each measure's `defaultAggregation`.

```graphql
getAggregates(
  groupBy: [GroupByInput!] = []      # empty: global aggregate, one row
  aggregates: [AggregateInput!]!     # 1 to API.AGGREGATES.MAX_AGGREGATES (20)
  structuredFilters: FilterNode
  sort: [AggregateSortInput!]
  limit: Int! = 100                  # number of GROUPS of the page
  offset: Int! = 0
  format: AggregateFormat = OBJECTS  # OBJECTS | ARRAYS | LONG
  includeRowCount: Boolean = true    # adds COUNT(*) as row_count
  catalog: String
  schema: String
): AggregateResult!

input GroupByInput {
  field: String!   # column to group by, at most once in groupBy
  grain: TimeGrain # DATE / TIMESTAMP columns only
}

enum TimeGrain { SECOND MINUTE HOUR DAY WEEK MONTH QUARTER YEAR }

input AggregateInput {
  measure: String!
  aggregation: Aggregation # absent: defaultAggregation, then SUM (numeric only)
  alias: String            # ^[a-z_][a-z0-9_]*$, default <measure>_<aggregation>
}

input AggregateSortInput {
  by: String!              # an output column: alias, group column, <field>__label, row_count
  order: SortOrder = ASC
}
```

#### Rules

- **Effective aggregation, per aggregate.** The `aggregation` argument wins. Without
  it, the measure's `defaultAggregation` applies, and then `SUM`, but only for a
  numeric measure. A non-numeric measure without `defaultAggregation` is a
  `BAD_USER_INPUT`: `COUNT` is never implied. The effective value is returned in
  `aggregates[].aggregation`.
- **Type families.** `SUM`, `AVG` and `MEDIAN` need a numeric measure. `MIN` and
  `MAX` need a numeric or temporal one. `MODE` and `COUNT` apply to any type.
  Anything else is a `BAD_USER_INPUT` that lists the allowed aggregations.
  `COUNT(measure)` counts non-NULL values, while `row_count` counts the rows of the group.
- **Aliases.** By default an alias is `<measure>_<aggregation in lower case>`
  (`value_sum`, `lower_bound_max`). An explicit alias must match
  `^[a-z_][a-z0-9_]*$`. Every output column name must be unique: group columns,
  label columns, aliases and `row_count`. Asking twice for the same aggregate
  therefore needs an alias.
- **Time grains.** `grain` truncates a `DATE` or `TIMESTAMP` column (`date_trunc`)
  before grouping. The output column keeps the name of the field and holds the
  first instant of each bucket: `MONTH` turns `2024-03-17` into `2024-03-01`.
  - `SECOND`, `MINUTE` and `HOUR` apply to `TIMESTAMP` columns only.
  - A `DATE` stays a `DATE` (`"YYYY-MM-DD"`).
  - A `TIMESTAMP WITH TIME ZONE` is truncated **in UTC**, so a day is a UTC day, whatever the server time zone.
  - `WEEK` starts on Monday.
  - Several temporal columns can be grouped at once, each with its own grain. The API never picks "the" time column for you.
- **Labels.** A group column (without grain) that has label columns
  (`Metadata.labelFields`, default rule: the only one, or the first alphabetically)
  gets a `<field>__label` column. It is read by `ANY_VALUE` in the same query and
  announced by `groupBy[].labelColumn`.
- **Sort and pagination.** Pagination applies to **groups**. Rows are sorted by
  `sort`, then by every group column (ascending) that `sort` does not already
  name. The order is therefore total and successive pages never overlap. `total`
  counts the groups, the `NULL` group included; it is `1` without `groupBy`.
- **Bounds.** At most `API.AGGREGATES.MAX_AGGREGATES` (20) aggregates and
  `API.AGGREGATES.MAX_GROUP_BY` (4) group columns. An empty `aggregates` list is
  a `BAD_USER_INPUT`, like an unknown column, a grain on a non-temporal column or
  an unknown sort column.

#### Result

```graphql
type AggregateResult {
  groupBy: [GroupColumn!]! # in the requested order
  aggregates: [AggregateColumn!]! # in the requested order
  columns: [String!]! # order of the columns of data
  data: [JSON!]!
  total: Float! # number of groups (1 without groupBy)
  hasNextPage: Boolean!
  generatedAt: String!
}

type GroupColumn {
  name: String! # column of data
  grain: TimeGrain
  labelColumn: String # <name>__label, or null
  field: Metadata! # label, typeFamily, unit…
  extent: JSON # [min, max] of the page (numeric or temporal), else null
}

type AggregateColumn {
  alias: String!
  measure: String!
  aggregation: Aggregation! # effective
  sqlType: String! # read from the result: SUM(BIGINT) → HUGEINT, AVG → DOUBLE, COUNT → BIGINT…
  unit: String # the measure's, null for COUNT
  displayFormat: String # the measure's; ",d" for COUNT; ",d" → ",.2f" for AVG/MEDIAN of an integer
  field: Metadata! # the measure
  extent: JSON # [min, max] of the page
}
```

The column descriptions are enough for axes, headers and tooltips, with no
second request. A `SUM` of a `BIGINT` beyond 2^53 is an exact decimal string,
like every other value (see _Value types_). An aggregate over a group without
any non-NULL value is `null`, never `0`.

#### Formats

- `OBJECTS`, the default, gives one object per group:
  `{ country: "France", value_sum: 1234.5, value_avg: 12.3, row_count: 100 }`.
- `ARRAYS` gives one array per group, ordered as `columns`.
- `LONG` is the tidy form, with one row per (group, aggregate):
  `{ country: "France", row_count: 100, measure: "value_sum", value: 1234.5 }`.
  - It is exactly the `OBJECTS` rows melted on the aliases, in the order of the aggregates.
  - `columns` is then the group columns, the label columns, `row_count`, `measure` and `value`.
  - Plot several aggregates as series by mapping the colour to `measure` (Vega-Lite, Observable Plot, D3).
  - A group column may not be named `measure` or `value` in this format.
  - A page holds up to `limit × aggregates` rows, since `limit` still counts groups.

The format is applied after the cache, so the three formats share one cache entry.

```graphql
query {
  getAggregates(
    groupBy: [{ field: "country" }]
    aggregates: [
      { measure: "value", aggregation: SUM }
      { measure: "value", aggregation: AVG }
      { measure: "lower_bound", aggregation: MAX }
    ]
    sort: [{ by: "value_sum", order: DESC }]
  ) {
    columns
    data
    total
    aggregates {
      alias
      aggregation
      sqlType
      unit
      displayFormat
      extent
    }
  }
}
```

#### Cost and cache

- **Complexity score:** 10, plus 2 per aggregate, plus 5 per explicit `MEDIAN` or
  `MODE`, plus 3 per group column, plus the rows of `limit`. The lengths of the lists
  are read from the arguments, including variables and their defaults.
  `Metadata.stats` under `groupBy.field` or `aggregates.field` costs one column per
  entry of the list.
- **Cache key:** the resolved parameters, that is the effective aggregations, the
  aliases, the label columns, the grains, the compiled filter, the effective sort and
  the page. Two orders of the same aggregates are two entries, because the order
  fixes the columns.
- **Group count:** it has an entry of its own, so paging never recounts the groups.

---

## Metadata queries

### `getMetaData`

Returns schema metadata for a single field.

```graphql
getMetaData(
  name: String!
  catalog: String
  schema: String
): Metadata

type Metadata {
  name: String!
  label: String!
  sqlType: String!                        # DuckDB type, as written by the database
  typeFamily: TypeFamily!                 # INTEGER NUMBER DATE TIMESTAMP TEXT BOOLEAN OTHER
  filterOperations: [FilterOperation!]!   # exactly what structuredFilters accepts
  isCategorical: Boolean!
  isPrimaryKey: Boolean!
  parentName: String
  labelFor: String
  labelFields: [String!]!
  unit: String
  displayFormat: String
  family: String
  description: String
  defaultAggregation: Aggregation
  stats: FieldStats                       # computed on demand
}
```

See [Building a filter UI](#building-a-filter-ui-typefamily-and-filteroperations)
for `typeFamily` and `filterOperations`.

---

## Catalog queries

### `getCatalogs`

Lists all registered catalogs with their default schema and the list of
served schemas — the ones the catalog holds (every one by default, or those of the
`SCHEMAS` allow-list) that pass the schema version guard; a schema in an unsupported
format is left out (and warned about in the API logs). Each schema is a
`CatalogSchemaInfo` whose `fields`
sub-field is **resolved lazily** — it only hits the database when the client
selects it, so `schemas { name }` is just as cheap as the old string-list and
`schemas { name fields { ... } }` fetches the whole cascade in one round-trip.

```graphql
getCatalogs: [Catalog!]!

type Catalog {
  id: String!                       # catalog identifier
  defaultSchema: String!            # schema used when `schema:` is omitted (1st of `schemas`)
  schemas: [CatalogSchemaInfo!]!    # schemas hosted by this catalog
}

type CatalogSchemaInfo {
  name: String!                # schema name (e.g., 'main', 'staging')
  fields: [Metadata!]!         # field metadata (lazy — fetched on selection)
}
```

### `getCatalogSchema`

Returns all field metadata for a given `(catalog, schema)` pair, **in the order
of the columns of the fact table** (the `metadata` table itself is stored
alphabetically). A metadata row without a column in the fact table comes last.
Both arguments are optional: `catalog` falls back to the routed catalog
(query argument, header, then default); `schema` falls back to the
catalog's default schema.

```graphql
getCatalogSchema(catalog: String, schema: String): [Metadata!]!
```

### `getSharedFields`

Returns the field names present in all specified targets — the columns that
are safe to use as `joinFields` in a cross-catalog comparison. Each target is
a `(catalog, schema)` pair; `schema` is optional and defaults to the catalog's
default schema. A field is shared when every target declares it **categorical**
under the same name and with the same SQL type family (two columns of the `other`
family, such as `TIME` or `BLOB`, must have the very same SQL type).

```graphql
getSharedFields(targets: [CatalogSchemaInput!]!): [String!]!

input CatalogSchemaInput {
  catalog: String!  # required catalog identifier
  schema: String    # optional schema; defaults to the catalog's default schema
}
```

---

## Select option queries

### `getSelectOptions`

Flat list of `{ value, label }` pairs for a categorical field, with optional search.

```graphql
getSelectOptions(
  fieldName: String!
  limit: Int = 50
  searchTerm: String = ""
  catalog: String
  schema: String
): [SelectOption!]!
```

### `getSelectOptionsTree`

Nested option tree of a column hierarchy (chain of columns declared through `Metadata.parentName`), read with a single `SELECT DISTINCT` over the chain.

```graphql
getSelectOptionsTree(
  fieldName: String!    # deepest level displayed (the leaves)
  maxDepth: Int         # levels kept going up from fieldName; default: whole chain
  searchTerm: String    # case-insensitive filter on the fieldName level
  catalog: String
  schema: String
): JSON!                # [{ value, label, children? }]
```

- `label` always equals `value`; `children` is absent on leaves.
- A NULL level ends its branch: the parent becomes a leaf, no empty node is produced.
- A column without `parentName` yields a one-level tree.
- With `searchTerm`, only branches leading to a matching leaf are kept (ancestors included).
- `maxDepth: 2` on `commune` (chain `region → departement → commune`) returns departements holding their own communes — the group-options format.
- `maxDepth < 1`, an unknown field, or a tree larger than `API.SELECT_OPTIONS.TREE_MAX_NODES` (default 5000) is rejected with `BAD_USER_INPUT` — never truncated.

---

## Cross-catalog queries

Each side is **aggregated by its keys before the join**, with the same SQL as `getAggregates`: a key that occurs on several fact rows yields one value per side, so a comparison returns one row per key common to both datasets (a key present on one side only is left out). Keys are matched on their stored values — the fact table carries the labels — cast to VARCHAR so two catalogs that type a column differently still align. Catalog A and B may be the same catalog with different schemas. `schemaA`/`schemaB` default to each catalog's configured schema. Every column must exist on both sides; the error names the side at fault.

A comparison computes deltas, so every compared aggregate must be numeric: SUM, AVG, MEDIAN or COUNT, or MIN/MAX/MODE of a numeric measure (`BAD_USER_INPUT` otherwise).

### `compareFacts`

Compares one measure of two datasets, one row per join key.

```graphql
compareFacts(
  catalogA: String!       # reference catalog
  catalogB: String!       # comparison catalog
  schemaA: String         # schema within catalogA (default: catalog's schema)
  schemaB: String         # schema within catalogB (default: catalog's schema)
  joinFields: [String!]!  # fields present in both datasets
  measure: String         # default: value (BAD_USER_INPUT when there is no such column)
  aggregation: Aggregation # default: defaultAggregation of the measure, then SUM if numeric
  limit: Int! = 100
  offset: Int! = 0        # at most API.PAGINATION.MAX_OFFSET
  sort: [SortInput!]      # key, keyLabel, valueA, valueB, delta, deltaPercent
): PaginatedComparedFacts!
```

- Each side computes `aggregation(measure)` grouped by `joinFields`; the two sides must agree on the aggregation: when their metadata declare different `defaultAggregation`s, pass `aggregation` explicitly.
- `ComparedFact` carries `key` (the join values, `::`-separated for several fields), `keyLabel` (single join field with a label column), `valueA`, `valueB`, `delta` (B − A) and `deltaPercent` ((B − A) / A × 100, null when A is 0). The result echoes the compared `measure` and `aggregation`.
- Rows are sorted by `sort`, then by every join field: the order is total, so pages never overlap nor skip a key. A NULL key matches nothing.

### `compareAggregatedFacts`

Compares several aggregates of two datasets over common group columns, in the shape of [`getAggregates`](#getaggregates): same `GroupByInput` (time grains included), `AggregateInput` (default aggregations and aliases) and `AggregateSortInput`.

```graphql
compareAggregatedFacts(
  catalogA: String!
  catalogB: String!
  schemaA: String
  schemaB: String
  groupBy: [GroupByInput!] = []     # empty: one global row
  aggregates: [AggregateInput!]!
  sort: [AggregateSortInput!]       # any column of data
  limit: Int! = 100
  offset: Int! = 0
): AggregateComparison!
```

Each row of `data` holds the group columns (values of side A), their label columns (`<field>__label`, COALESCE of both sides), then four columns per aggregate:

| Column              | Value                                           |
| ------------------- | ----------------------------------------------- |
| `<alias>_a`         | aggregate in dataset A                          |
| `<alias>_b`         | aggregate in dataset B                          |
| `<alias>_delta`     | `<alias>_b − <alias>_a`                         |
| `<alias>_delta_pct` | `(b − a) / a × 100`, null when `a` is 0 or null |

`aggregates` describes each aggregate as in `getAggregates` (`alias` is the prefix of its four columns; `sqlType` is the type of `<alias>_a`; `extent` spans `<alias>_a` and `<alias>_b`, for a shared axis). Groups are joined NULL-safe (a NULL group of A matches the NULL group of B) and sorted by `sort`, then by every group column. Both sides must resolve each aggregate to the same aggregation and each grained column to the same truncation, otherwise `BAD_USER_INPUT`.

### `crossDatabaseSelectOptions`

Returns only the select options that exist in all specified catalogs (intersection).

```graphql
crossDatabaseSelectOptions(
  fieldName: String!
  catalogs: [String!]!
  schemas: [String!]      # aligned by index with catalogs
  limit: Int! = 50
): [SelectOption!]!
```
