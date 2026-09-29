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
      name # served schemas of the catalog (1st = default, `main` when present)
    }
  }
}
```

`getCatalogs` returns each catalog with its identifier, default schema, and
the list of served schemas (those in a format the API supports). Per-schema details (`fields`) are exposed as
sub-fields and only loaded when the client requests them —
see the cascade example below — or via `getCatalogSchema` / `getFields`.

## Inspect a schema's fields

```graphql
query {
  getCatalogSchema(catalog: "macroeconomics") {
    name
    label
    sqlType
    isCategorical
  }
}
```

## Cascade introspection: catalogs → schemas → fields

A single round-trip can fetch every catalog with the metadata of every one
of its schemas. The `fields` sub-field is resolved lazily through GraphQL's
selection set, so requesting `schemas { name }` is just as cheap as the
previous example — only adding `fields` triggers the per-schema loads (each
load is batched and DataLoader-cached, so a multi-schema catalog hits the
database once per schema, in parallel).

```graphql
query {
  getCatalogs {
    id
    defaultSchema
    schemas {
      name
      fields {
        name
        label
        sqlType
        isCategorical
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
    isCategorical
    sqlType
  }
}
```

The same `schema` argument is available on every data query
(`getFactTable`, `getAggregatedFacts`, `getMetaData`,
`getSelectOptions`, `getSelectOptionsTree`, `getFields`). An unknown
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
    sqlType
    isCategorical
  }
}
```

### Modalities of a categorical column

```graphql
query {
  getSelectOptions(fieldName: "country", catalog: "macroeconomics", schema: "staging") {
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
      keys {
        name
        value
      }
      measures {
        name
        value
      }
    }
  }
}
```

### Aggregated facts

```graphql
query {
  getAggregatedFacts(
    groupBy: "country"
    measure: "gdp_growth"
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

## Browse the modalities of a column

The fact table stores labels, so a menu is a `SELECT DISTINCT` over the
column and `label` equals `value` — except on a code column that has label
columns (`Metadata.labelFields`), where `value` is the code and `label` its
label (see [Codes and labels](./queries)).

```graphql
query {
  getSelectOptions(fieldName: "country", catalog: "macroeconomics") {
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
    structuredFilters: {
      children: [
        { criterion: { variable: "year", operation: GTE, value: 2010 } }
        {
          connector: AND
          criterion: { variable: "country", operation: IN, value: ["FRA", "DEU", "ESP"] }
        }
      ]
    }
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
      keys {
        name
        value
      }
      measures {
        name
        value
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
    structuredFilters: {
      children: [{ criterion: { variable: "year", operation: GTE, value: 2015 } }]
    }
    limit: 200
    format: OBJECTS
    catalog: "macroeconomics"
  ) {
    columns
    fields {
      name
      label
      sqlType
      unit
      displayFormat
    }
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
    measure: "gdp_growth"
    aggregation: AVG
    structuredFilters: {
      children: [{ criterion: { variable: "year", operation: GTE, value: 2010 } }]
    }
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

Groups tied on `aggregatedValue` are always ordered by their key, so two
successive pages never overlap. `key` is `null` for the group of the rows where
the column is NULL (a missing level of a hierarchy, for instance), and
`aggregatedValue` is `null` when the group holds no value of the measure.

`aggregatedValue` is a JSON value, serialized like any value of the fact table:
a number for COUNT, SUM, AVG and MEDIAN (an integer sum beyond 2^53 comes back
as its exact decimal string), a number or an ISO 8601 date for MIN and MAX, and
a value of the measure for MODE. The aggregation must suit the type of the
measure: SUM, AVG and MEDIAN need a numeric measure, MIN and MAX a numeric or
temporal one, and MODE and COUNT work on any column. Any other combination is
rejected with `BAD_USER_INPUT`, and the error lists the aggregations allowed.
When `aggregation` is omitted, the measure's `defaultAggregation` applies,
falling back to SUM for a numeric measure only.

```graphql
query {
  getAggregatedFacts(groupBy: "country", measure: "date", aggregation: MAX, limit: 20) {
    key
    aggregatedValue # "2024-01-01"
  }
}
```

## Aggregation with statistics

```graphql
query {
  getAggregatedFactsWithMetadata(
    groupBy: "country"
    measure: "gdp_growth"
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

`valueExtent` is `[min, max]` over the non-NULL values of the page: numbers, or
ISO 8601 dates for MIN, MAX or MODE of a temporal measure. It is `null` for an
empty page, a page that holds only NULLs, or a text or boolean MODE. `statistics`
is `null` when the aggregated value is not numeric.

## Schema introspection for a field

```graphql
query {
  getMetaData(name: "gdp_growth", catalog: "macroeconomics") {
    name
    label
    sqlType
    isCategorical
    isPrimaryKey
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

## Select options tree (group-options menus)

A hierarchy is a chain of columns declared through `Metadata.parentName`
(`region → departement → commune`). `maxDepth: 2` on the leaf level returns
departements holding their own communes — the group-options format:

```graphql
query {
  getSelectOptionsTree(fieldName: "commune", maxDepth: 2, schema: "geography")
}
```

Excerpt of the result:

```json
[
  {
    "value": "Côte-d'Or",
    "label": "Côte-d'Or",
    "children": [
      { "value": "Beaune", "label": "Beaune" },
      { "value": "Dijon", "label": "Dijon" }
    ]
  },
  { "value": "Saône-et-Loire", "label": "Saône-et-Loire" }
]
```

A departement without communal level (`commune` NULL) is a leaf. Add
`searchTerm` to filter the leaves; their ancestors are kept.

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
      valueA
      valueB
      delta
      deltaPercent
    }
  }
}
```

## Shared fields across catalogs

`getSharedFields` takes a list of `(catalog, schema)` targets and returns the
categorical columns every target declares under the same name and SQL type
family — the columns usable as `joinFields` in a comparison. Each target's
`schema` is optional and defaults to the catalog's default schema.

```graphql
query {
  getSharedFields(
    targets: [{ catalog: "macroeconomics" }, { catalog: "public_finance", schema: "staging" }]
  )
}
```

## Targeting a different catalog

Every query accepts a `catalog` argument (and `schema` for a non-default schema within it); there is no
HTTP-header alternative — a client that cannot modify each query still passes it as a variable:

```bash
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ getSelectOptions(fieldName: \"country\", catalog: \"macroeconomics\") { value label } }"}'
```
