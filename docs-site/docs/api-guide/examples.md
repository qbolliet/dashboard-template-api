---
title: Examples
sidebar_position: 3
---

# Example Queries

All examples assume the server is running at `http://localhost:4000/graphql`.

## Discover available catalogs

```graphql
query {
  getDatabases {
    id
    dimensionNames
    fields {
      name
      label
      sql_type
      is_categorical
    }
  }
}
```

## Browse a dimension

```graphql
query {
  getDimensionTable(name: "country", database: "macroeconomics") {
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
    database: "macroeconomics"
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
    structuredFilters: [
      { key: "year", operator: ">=", value: "2015" }
    ]
    limit: 200
    format: OBJECTS
    database: "macroeconomics"
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
    structuredFilters: [
      { key: "year", operator: ">=", value: "2010" }
    ]
    sort: [{ field: "aggregatedValue", order: DESC }]
    limit: 20
    database: "macroeconomics"
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
    database: "public_finance"
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
  getMetaData(name: "gdp_growth", database: "macroeconomics") {
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
  getSelectOptions(
    fieldName: "country"
    searchTerm: "fr"
    limit: 10
    database: "macroeconomics"
  ) {
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
    database: "macroeconomics"
  ) {
    group { value label }
    options { value label }
  }
}
```

## Cross-database comparison

```graphql
query {
  compareAggregatedFacts(
    databaseA: "macroeconomics"
    databaseB: "public_finance"
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

```graphql
query {
  getSharedDimensions(databases: ["macroeconomics", "public_finance"])
}
```

## Using a different catalog via HTTP header

For clients that cannot modify each query, pass the catalog ID as a header:

```bash
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -H "x-database-id: macroeconomics" \
  -d '{"query": "{ getDimensionTable(name: \"country\") { value label } }"}'
```
