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

| Family  | SQL types                                                                                           | Operations                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| numeric | `TINYINT` `SMALLINT` `INTEGER` `BIGINT` `HUGEINT` `U*INT` `UBIGINT` `FLOAT` `DOUBLE` `DECIMAL(p,s)` | `EQ NEQ GT GTE LT LTE BETWEEN NOT_BETWEEN IN NOT_IN IS_NULL IS_NOT_NULL`                                                         |
| date    | `DATE` `TIMESTAMP` (`_S` `_MS` `_NS`, `WITH TIME ZONE`)                                             | `EQ NEQ BEFORE AFTER ON_OR_BEFORE ON_OR_AFTER BETWEEN NOT_BETWEEN IN NOT_IN IS_NULL IS_NOT_NULL`                                 |
| text    | `VARCHAR`                                                                                           | `EQ NEQ IEQ CONTAINS NOT_CONTAINS ICONTAINS STARTS NOT_STARTS ISTARTS ENDS NOT_ENDS IENDS MATCHES IN NOT_IN IS_NULL IS_NOT_NULL` |
| boolean | `BOOLEAN`                                                                                           | `EQ NEQ IS_TRUE IS_FALSE IS_NOT_TRUE IS_NOT_FALSE IS_NULL IS_NOT_NULL`                                                           |

The `I*` operations (`IEQ`, `ICONTAINS`, `ISTARTS`, `IENDS`) are the case-insensitive
twins of their `LIKE` counterparts (SQL `ILIKE`); `IEQ` adds no wildcard, so it is a
case-insensitive equality. `MATCHES` compiles to DuckDB's `regexp_matches` (RE2
syntax: no backreferences, no lookaround); patterns are capped at
`MAX_PATTERN_LENGTH` (200 characters) and must be syntactically valid. On a nullable
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

---

### `getAggregatedFacts`

Grouped aggregation for charts.

```graphql
getAggregatedFacts(
  fields: [String!]
  structuredFilters: FilterNode
  groupBy: String!
  aggregation: Aggregation! = SUM
  limit: Int! = 100
  offset: Int! = 0
  sort: [SortInput!]
  catalog: String
  schema: String
): [AggregatedFact]
```

---

### `getAggregatedFactsWithMetadata`

Same as `getAggregatedFacts` but includes D3-ready statistics (mean, median, std-dev, quartiles, key/value extents).

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
  name: String
  label: String
  sql_type: String
  is_categorical: Boolean
  is_primary_key: Boolean
}
```

---

## Catalog queries

### `getCatalogs`

Lists all registered catalogs with their default schema and the list of
hosted schemas. Each schema is a `CatalogSchemaInfo` whose `fields`
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

Returns all field metadata for a given `(catalog, schema)` pair. Both
arguments are optional: `catalog` falls back to the routed catalog
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
under the same name and with the same SQL type family.

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

### `getGroupedSelectOptions`

Two-level structure: a list of group options and a list of child options, for cascaded dropdowns.

```graphql
getGroupedSelectOptions(
  groupField: String!
  optionsField: String!
  limit: Int = 50
  catalog: String
  schema: String
): GroupedSelectOptions!

type GroupedSelectOptions {
  group: [SelectOption!]!
  options: [SelectOption!]!
}
```

---

## Cross-catalog queries

Join fields are matched directly on their stored values — the fact table carries the labels — cast to VARCHAR so two catalogs that type a column differently still align. Catalog A and B may be the same catalog with different schemas. `schemaA`/`schemaB` default to each catalog's configured schema.

### `compareFacts`

Joins facts from two catalogs on shared fields and computes deltas.

```graphql
compareFacts(
  catalogA: String!       # reference catalog
  catalogB: String!       # comparison catalog
  schemaA: String         # schema within catalogA (default: catalog's schema)
  schemaB: String         # schema within catalogB (default: catalog's schema)
  joinFields: [String!]!  # fields present in both datasets
  limit: Int! = 100
  offset: Int! = 0
  sort: [SortInput!]
): PaginatedComparedFacts!
```

### `compareAggregatedFacts`

Same as `compareFacts` but for aggregated values with a shared `groupBy`.

```graphql
compareAggregatedFacts(
  catalogA: String!
  catalogB: String!
  schemaA: String
  schemaB: String
  groupBy: String!
  aggregation: Aggregation! = SUM
  limit: Int! = 100
  offset: Int! = 0
): PaginatedComparedFacts!
```

`ComparedFact` carries `valueA`, `valueB`, `delta` (absolute), and `deltaPercent` (relative).

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
