---
title: Queries Reference
sidebar_position: 2
---

# Queries Reference

All operations are GraphQL queries (read-only). Send them to `POST /graphql` with `Content-Type: application/json`.

## Common input types

### Filter

Applies a condition on a field:

```graphql
input Filter {
  key: String! # field name
  operator: String! # "=", "!=", ">", ">=", "<", "<=", "IN", "NOT IN", "LIKE"
  value: String # single value
  values: [String!] # list of values (for IN / NOT IN)
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

Paginated fact rows with dimension labels.

```graphql
getFactTable(
  fields: [String!]            # columns to return (omit for all)
  filters: String              # raw SQL WHERE clause (legacy)
  structuredFilters: [Filter]  # structured filter array (recommended)
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
  value: Float
  dimensionDetails: [DimensionDetail]
}

type DimensionDetail {
  name: String!
  value: String!
  label: String!
}
```

---

### `getFactTableWithMetadata`

D3-optimised dataset with column metadata and extents.

```graphql
getFactTableWithMetadata(
  fields: [String!]
  filters: String
  structuredFilters: [Filter]
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
  filters: String
  structuredFilters: [Filter]
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

## Dimension queries

### `getDimensionTable`

Returns the full list of values and labels for a categorical dimension.

```graphql
getDimensionTable(
  name: String!       # dimension field name
  catalog: String
  schema: String
): [Dimension]

type Dimension {
  value: String
  label: String
}
```

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
  python_type: String
  sql_type: String
  is_categorical: Boolean
  is_primary_key: Boolean
}
```

---

## Catalog queries

### `getDatabases`

Lists all registered catalogs with their fields and dimension names.

```graphql
getDatabases: [DatabaseInfo!]!

type DatabaseInfo {
  id: String!
  schemas: [String!]!         # schemas hosted by the catalog (1st = default)
  fields: [Metadata!]!        # field metadata for the default schema
  dimensionNames: [String!]!  # categorical field names for the default schema
}
```

### `getDatabaseSchema`

Returns all field metadata for a catalog.

```graphql
getDatabaseSchema(catalog: String, schema: String): [Metadata!]!
```

### `getSharedDimensions`

Returns the dimension names present in all specified catalogs.

```graphql
getSharedDimensions(catalogs: [String!]!, schemas: [String!]): [String!]!
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

Categorical fields are matched on their `dim_*` labels (never the raw ID, which is local to each catalog/schema). Catalog A and B may be the same catalog with different schemas. `schemaA`/`schemaB` default to each catalog's configured schema.

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
