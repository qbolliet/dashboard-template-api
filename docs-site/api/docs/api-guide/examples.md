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
(`getFactTable`, `getAggregates`, `getMetaData`,
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

### Aggregates

```graphql
query {
  getAggregates(
    groupBy: [{ field: "country" }]
    aggregates: [{ measure: "gdp_growth", aggregation: AVG }]
    limit: 20
    catalog: "macroeconomics"
    schema: "staging"
  ) {
    columns
    data
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

## Grouped bar chart

Two group columns and one aggregate: `country` on the x axis, `kind` as the colour
(hue), `value_sum` as the bar height. One request yields the rows and everything
the chart needs to label itself: the axis titles come from `groupBy[].field.label`,
and the tick format and tooltip suffix from `aggregates[].displayFormat` and
`aggregates[].unit`.

```graphql
query GroupedBars($filter: FilterNode) {
  getAggregates(
    groupBy: [{ field: "country" }, { field: "kind" }]
    aggregates: [{ measure: "value", aggregation: SUM }]
    structuredFilters: $filter
    sort: [{ by: "country" }]
    limit: 500
  ) {
    columns # ["country", "kind", "value_sum", "row_count"]
    data # [{ country: "France", kind: "Actual", value_sum: 493.36, row_count: 144 }, …]
    total
    hasNextPage
    groupBy {
      name
      field {
        label
        typeFamily
      }
    }
    aggregates {
      alias
      unit
      displayFormat
      extent
    }
  }
}
```

```js
// x = country, hue = kind, y = alias of the aggregate
const { data, aggregates } = result.getAggregates;
const y = aggregates[0].alias; // "value_sum"
const series = d3.group(data, (row) => row.kind); // one series per kind
const yDomain = [0, aggregates[0].extent[1]]; // max of the page
```

Bars stay correct on the whole filtered dataset: the API sums every row, not just
a loaded page, and it applies the measure's `defaultAggregation` when
`aggregation` is omitted. Pagination applies to groups. A page ends on a group
boundary, and its rows are ordered by `sort` then by every group column, so two
pages never overlap. `limit` is a number of (country, kind) pairs.

A group column with label columns adds `<field>__label` to the rows. For example
`nc8` gives `nc8__label: "Pure-bred breeding horses"`, announced by
`groupBy[].labelColumn`. Display `row[labelColumn] ?? row[name]`.

## Several measures as series (LONG)

Monthly series of three aggregates, plotted as three lines. `format: LONG` melts
the aggregates into a `measure` column (the alias) and a `value` column, so each
aggregate becomes a series without any client-side reshaping. This is the tidy
form Vega-Lite and Observable Plot expect.

```graphql
query Series {
  getAggregates(
    groupBy: [{ field: "date", grain: MONTH }]
    aggregates: [
      { measure: "value", aggregation: SUM, alias: "total" }
      { measure: "value", aggregation: AVG, alias: "mean" }
      { measure: "lower_bound", aggregation: MIN, alias: "floor" }
    ]
    format: LONG
    limit: 120 # 120 months, hence up to 360 rows
  ) {
    columns # ["date", "row_count", "measure", "value"]
    data # [{ date: "2022-01-01", row_count: 48, measure: "total", value: 206.18 }, …]
    aggregates {
      alias
      unit
      displayFormat
    }
  }
}
```

```js
// x = date, y = value, colour = measure (the alias)
Plot.lineY(result.getAggregates.data, { x: 'date', y: 'value', stroke: 'measure' });
```

- `MONTH` truncates each date to the first day of its month, and `YEAR`, `QUARTER`,
  `WEEK` (Monday) and `DAY` work the same way.
- On a `TIMESTAMP` column, `HOUR`, `MINUTE` and `SECOND` are also available. A
  `TIMESTAMP WITH TIME ZONE` is truncated in UTC.
- Each group column carries its own grain, and several temporal columns can be
  combined: `[{ field: "date", grain: MONTH }, { field: "ingested_at", grain: HOUR }]`.
- `LONG` is `OBJECTS` melted on the aliases, in the order of the aggregates: drop
  `format: LONG` to get one object per month with `total`, `mean` and `floor`
  columns.
- The measures need not share a unit: read `aggregates[]` by alias to format each
  series.

## Global aggregate (KPI tiles)

Without `groupBy`, the aggregate covers the whole filtered dataset in one row,
even when no row matches the filter. In that case the aggregates are `null` and
`row_count` is `0`.

```graphql
query Kpis($filter: FilterNode) {
  getAggregates(
    aggregates: [
      { measure: "value" } # defaultAggregation of value: SUM
      { measure: "quality_score" } # defaultAggregation: AVG
      { measure: "date", aggregation: MAX, alias: "last_date" }
    ]
    structuredFilters: $filter
  ) {
    data # [{ value_sum: 7446.16, quality_score_avg: 0.82, last_date: "2024-12-01", row_count: 1729 }]
    aggregates {
      alias
      aggregation
      unit
      displayFormat
      field {
        label
      }
    }
  }
}
```

The aggregation must suit the type of the measure:

- `SUM`, `AVG` and `MEDIAN` need a numeric measure;
- `MIN` and `MAX` need a numeric or temporal one;
- `MODE` and `COUNT` work on any column.

Any other combination is rejected with `BAD_USER_INPUT`, and the error lists the
aggregations allowed. An integer sum beyond 2^53 comes back as its exact decimal
string (`aggregates[].sqlType` is then `HUGEINT`).

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
