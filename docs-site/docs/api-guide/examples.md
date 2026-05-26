---
title: Examples
sidebar_position: 3
---

# Example Queries

All examples assume the server is running at `http://localhost:4000/graphql`.

## Discover available catalogs

```graphql
query {
  getCatalogs {
    id
    defaultSchema
    schemas {
      name # list of DuckLake schemas hosted by the catalog (1st = default)
    }
  }
}
```

`getCatalogs` returns each catalog with its identifier, default schema, and
the list of hosted schemas. Per-schema details (`fields`, `dimensionNames`)
are exposed as sub-fields and only loaded when the client requests them —
see the cascade example below — or via `getCatalogSchema` / `getFields`.

## Inspect a schema's fields

```graphql
query {
  getCatalogSchema(catalog: "macroeconomics") {
    name
    label
    sql_type
    is_categorical
  }
}
```

## Cascade introspection: catalogs → schemas → fields

A single round-trip can fetch every catalog with the metadata of every one
of its schemas. The `fields` and `dimensionNames` sub-fields are resolved
lazily through GraphQL's selection set, so requesting `schemas { name }` is
just as cheap as the previous example — only adding `fields` or
`dimensionNames` triggers the per-schema loads (each load is batched and
DataLoader-cached, so a multi-schema catalog hits the database once per
schema, in parallel).

```graphql
query {
  getCatalogs {
    id
    defaultSchema
    schemas {
      name
      dimensionNames
      fields {
        name
        label
        sql_type
        is_categorical
      }
    }
  }
}
```

## Target a specific schema within a catalog

A catalog can host several schemas. Pass `schema:` to query a non-default one:

```graphql
query {
  getCatalogSchema(catalog: "default", schema: "staging") {
    name
    label
    is_categorical
    sql_type
  }
}
```

The same `schema` argument is available on every data query
(`getFactTable`, `getAggregatedFacts`, `getMetaData`, `getDimensionTable`,
`getSelectOptions`, `getGroupedSelectOptions`, `getFields`). An unknown
schema returns a `GraphQLError` (allow-list validation).

## Targeting a specific schema across data queries

The examples below all hit the `staging` schema of the `macroeconomics`
catalog. Omit `schema:` to fall back to the catalog's default schema.

### Field metadata

```graphql
query {
  getMetaData(name: "gdp_growth", catalog: "macroeconomics", schema: "staging") {
    name
    label
    sql_type
    is_categorical
  }
}
```

### Dimension table

```graphql
query {
  getDimensionTable(name: "country", catalog: "macroeconomics", schema: "staging") {
    value
    label
  }
}
```

### Paginated fact table

```graphql
query {
  getFactTable(
    fields: ["year", "country", "gdp_growth"]
    limit: 50
    offset: 0
    catalog: "macroeconomics"
    schema: "staging"
  ) {
    total
    data {
      value
    }
  }
}
```

### Aggregated facts

```graphql
query {
  getAggregatedFacts(
    groupBy: "country"
    aggregation: AVG
    limit: 20
    catalog: "macroeconomics"
    schema: "staging"
  ) {
    key
    aggregatedValue
  }
}
```

### Select options for a dropdown

```graphql
query {
  getSelectOptions(
    fieldName: "country"
    searchTerm: "fr"
    limit: 10
    catalog: "macroeconomics"
    schema: "staging"
  ) {
    value
    label
  }
}
```

## Browse a dimension

```graphql
query {
  getDimensionTable(name: "country", catalog: "macroeconomics") {
    value
    label
  }
}
```

## Paginated fact table

```graphql
query {
  getFactTable(
    fields: ["year", "country", "gdp_growth"]
    structuredFilters: [
      { key: "year", operator: ">=", value: "2010" }
      { key: "country", operator: "IN", values: ["FRA", "DEU", "ESP"] }
    ]
    sort: [{ field: "year", order: DESC }]
    limit: 50
    offset: 0
    catalog: "macroeconomics"
  ) {
    total
    hasNextPage
    currentPage
    totalPages
    data {
      value
      dimensionDetails {
        name
        value
        label
      }
    }
  }
}
```

## D3-ready dataset

```graphql
query {
  getFactTableWithMetadata(
    fields: ["year", "country", "gdp_growth"]
    structuredFilters: [{ key: "year", operator: ">=", value: "2015" }]
    limit: 200
    format: OBJECTS
    catalog: "macroeconomics"
  ) {
    columns
    data
    metadata {
      count
      total
      hasNextPage
      extents
      generatedAt
    }
  }
}
```

## Bar chart aggregation

```graphql
query {
  getAggregatedFacts(
    groupBy: "country"
    aggregation: AVG
    structuredFilters: [{ key: "year", operator: ">=", value: "2010" }]
    sort: [{ field: "aggregatedValue", order: DESC }]
    limit: 20
    catalog: "macroeconomics"
  ) {
    key
    aggregatedValue
    count
  }
}
```

## Aggregation with statistics

```graphql
query {
  getAggregatedFactsWithMetadata(
    groupBy: "country"
    aggregation: SUM
    limit: 50
    catalog: "public_finance"
  ) {
    data {
      key
      aggregatedValue
      count
    }
    metadata {
      count
      valueExtent
      statistics {
        mean
        median
        stdDev
        quartiles
      }
      generatedAt
    }
  }
}
```

## Schema introspection for a field

```graphql
query {
  getMetaData(name: "gdp_growth", catalog: "macroeconomics") {
    name
    label
    sql_type
    is_categorical
    is_primary_key
  }
}
```

## Select options for a dropdown

```graphql
query {
  getSelectOptions(fieldName: "country", searchTerm: "fr", limit: 10, catalog: "macroeconomics") {
    value
    label
  }
}
```

## Grouped select options (cascaded dropdowns)

```graphql
query {
  getGroupedSelectOptions(
    groupField: "region"
    optionsField: "country"
    limit: 100
    catalog: "macroeconomics"
  ) {
    group {
      value
      label
    }
    options {
      value
      label
    }
  }
}
```

## Cross-database comparison

```graphql
query {
  compareAggregatedFacts(
    catalogA: "macroeconomics"
    catalogB: "public_finance"
    groupBy: "country"
    aggregation: SUM
    limit: 30
  ) {
    total
    data {
      key
      keyLabel
      valueA
      valueB
      delta
      deltaPercent
    }
  }
}
```

## Shared dimensions across catalogs

`getSharedDimensions` takes a list of `(catalog, schema)` targets. Each
target's `schema` is optional and defaults to the catalog's default schema.

```graphql
query {
  getSharedDimensions(
    targets: [{ catalog: "macroeconomics" }, { catalog: "public_finance", schema: "staging" }]
  )
}
```

## Using a different catalog via HTTP header

For clients that cannot modify each query, pass the catalog ID as a header:

```bash
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -H "x-catalog-id: macroeconomics" \
  -d '{"query": "{ getDimensionTable(name: \"country\") { value label } }"}'
```
