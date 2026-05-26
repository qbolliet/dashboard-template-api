---
title: Data Loading
sidebar_position: 4
---

# Data Loading

## DuckDB connection pool

Each registered DuckLake catalog has its own connection pool (`src/db/pool.ts`). The pool:

- Maintains up to `MAX_CONNECTIONS` (5) open DuckDB connections per catalog
- Queues acquisition requests when all connections are in use
- Times out after `ACQUIRE_TIMEOUT` (60 000 ms) if no connection becomes available
- Retries failed acquisitions with `POOL_RETRY_DELAY` (500 ms) between attempts

All connections are opened in **read-only** mode (`READ_ONLY: true`) — DuckDB enforces this at the file level, providing an extra guarantee that no mutation can reach the data.

## DataLoader pattern

GraphQL resolvers use [DataLoader](https://github.com/graphql/dataloader) to batch and deduplicate database calls within a single request.

### Why DataLoader?

Consider a query that requests 50 fact rows, each with `dimensionDetails`. Naively, this would execute 50 individual `getDimensionTable` calls. With DataLoader:

1. All 50 calls are collected into a single batch
2. The batch function executes one SQL query for all requested keys at once
3. Results are distributed back to each waiting resolver

This reduces N+1 queries to a fixed number of SQL statements per request.

### Loader hierarchy

```
src/loaders/
├── base-loader.ts          # Abstract base: batch fn, cache logic, error handling
├── fact.ts                 # Batch fact table queries
├── dimension.ts            # Batch dimension lookups
├── metadata.ts             # Batch field metadata
├── select-options.ts       # Batch select option lists
├── aggregated-facts.ts     # Batch aggregation queries
├── catalog.ts              # Batch catalog info queries
└── cross-database.ts       # Batch cross-catalog operations
```

`base-loader.ts` handles:

- Constructing the cache key from query parameters
- Checking/populating the Redis cache
- Error normalisation so a single loader failure does not corrupt the whole batch

Cache keys are namespaced by `(catalog, schema)` so two schemas of the same catalog never share a cache entry — important because categorical IDs are assigned per-schema and the same integer ID can label different modalities across schemas. Table names are likewise qualified as `"catalog".schema.table_name` at every SQL boundary (`base-loader.ts:qualifyTable`).

### Request context

A new set of loader instances is created per GraphQL request in the Apollo context factory (`src/server.ts`). This ensures:

- DataLoader's in-memory cache is reset between requests (no data leakage)
- Each request has isolated concurrency control

## Multi-catalog / multi-schema routing

The `DatabaseManager` (`src/db/database-manager.ts`) is a singleton that owns the shared DuckDB pool with every DuckLake catalog attached, plus the per-catalog allow-list of schemas. Resolvers route a query to the right `(catalog, schema, table)` triplet.

Selection priority for the **catalog** and the **schema** (independent axes):

1. GraphQL argument (`catalog: "…"`, `schema: "…"`) on the field
2. HTTP header (`X-Catalog-ID`, `X-Schema-ID`) on the request
3. `DEFAULT_CATALOG` config value, then the first element of `SCHEMAS` for that catalog (defaults to `main`)

Validation:

- `catalog` is checked against `ALLOWED_CATALOGS`.
- `schema` is checked against the per-catalog allow-list (`databaseManager.isValidSchema(catalog, schema)`), which is reconciled at startup between the configured `SCHEMAS` and what `information_schema.schemata` actually returns from the live engine.

An invalid catalog or schema produces a structured `GraphQLError` listing the available values.

## Dimension enrichment

Fact rows contain raw dimension values (e.g. `country: "FRA"`). The `dimensionDetails` field resolver (`src/utils/dimension-enrichment.ts`) enriches these with human-readable labels by:

1. Detecting which fields in the row are categorical (via metadata)
2. Batching a `getDimensionTable` call for each dimension through the DataLoader
3. Joining labels onto the fact row before returning it to the client

This enrichment is lazy — it only runs when the client requests `dimensionDetails` in the query.
