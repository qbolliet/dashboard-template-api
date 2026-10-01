---
title: Security
sidebar_position: 2
---

# Security Architecture

The API applies security checks in layers, from the outermost HTTP middleware down to field-level resolution. Each layer is independently configurable.

## Layer 1 — HTTP middleware

Applied by Express before any GraphQL processing:

- **CORS** — only allows origins listed in `config/api.yaml` (`API.CORS.ORIGINS`)
- **HSTS** — `Strict-Transport-Security` header (configurable max-age)
- **Compression** — response compression reduces data transfer but does not expose new attack surface
- **Request size limits** — body size, field size, and field count caps prevent oversized payloads

## Layer 2 — Rate limiter (`src/security/rate-limiter.ts`)

Two sliding-window counters are kept in memory (per pod) for each client IP:

| Window             | Purpose                                    |
| ------------------ | ------------------------------------------ |
| Sustained (15 min) | Prevents data scraping and bulk harvesting |
| Burst (1 min)      | Prevents sudden request spikes             |

When either limit is exceeded the request is rejected with HTTP `429` before it reaches GraphQL.

If the API runs behind a reverse proxy, configure `TRUSTED_PROXIES` (IPs or CIDR blocks, fed to Express's `trust proxy`) so that the real IP is read from `x-forwarded-for` rather than the proxy IP. The admin routes (`/api/cache/*`, `/api/catalog/*`) have their own strict limiter (`ADMIN_RATE_LIMIT`, 10 req/min/IP). See [security.yaml](../configuration/security.md#trusted-proxies-trusted_proxies).

## Layer 3 — GraphQL validation rules

Applied by Apollo Server during the validation phase (before execution): Apollo's specified rules (unknown fields and arguments, missing selections, `NoIntrospection` when introspection is off) plus the depth limit.

### Depth limiter (`src/security/depth-limit.ts`)

Rejects queries whose selection set nesting exceeds `MAX_QUERY_DEPTH` (7 in production, 15 in development). This prevents deeply recursive queries that could consume disproportionate resources.

## Layer 4 — Operation checks (`src/security/manager.ts`)

Run in Apollo's `didResolveOperation` hook, after validation and before any resolver: a rejected operation never reaches the database. Both answer HTTP `400`.

- **Operation type** — only `query` operations run; a mutation or subscription gets `OPERATION_TYPE_NOT_ALLOWED`.
- **Complexity** — see below; an over-budget operation gets `QUERY_COMPLEXITY_EXCEEDED`.

### Complexity scale (`src/security/complexity-analyzer.ts`)

Every value lives in `SECURITY.COMPLEXITY` of `config/security.yaml`. Two ceilings apply to an operation:

| Ceiling           | Value | Rule                                                                                                            |
| ----------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `MAX_ROOT_FIELDS` | 20    | Root fields of the operation, aliases and fragments at the root included (`__typename` excluded). Checked first |
| `MAX_ALLOWED`     | 200   | Sum of the scores below                                                                                         |

The score of an operation is the sum, over its root fields, of:

| Component            | Cost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root field           | `ROOT_FIELD_SCORES[name]`, or `DEFAULT_ROOT_FIELD_SCORE` (5) for a field missing from the table — never zero. A test fails when a `Query` field has no entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rows (`limit`)       | `ROW_COST` (0.1) × `limit`, the rows bounded by `API.PAGINATION.MAX_LIMIT` (1000, i.e. 100 points at most): above that bound the resolver answers `BAD_USER_INPUT` before any SQL. An omitted `limit` is charged at its SDL default (`limit: Int! = 100` → 10 points), a `null` one at `API.PAGINATION.DEFAULT_LIMIT`                                                                                                                                                                                                                                                                                                                                                   |
| Filter / sort        | +2 for `structuredFilters`, +1 for `sort`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `getAggregates`      | `AGGREGATE_COST` (2) per aggregate, plus `HOLISTIC_AGGREGATE_COST` (5) per explicit `MEDIAN` or `MODE` (a sort or a frequency table per group), plus `GROUP_COLUMN_COST` (3) per group column. The lists are read from the effective argument values, variables and their defaults included; an aggregation implied by `defaultAggregation` is unknown at this stage and pays `AGGREGATE_COST` only                                                                                                                                                                                                                                                                     |
| Nested object field  | `OBJECT_COST` (1) × `DEPTH_FACTOR` (1.5)^depth; scalar leaves cost `SCALAR_COST` (0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Metadata.stats`     | `STATS_COST_PER_COLUMN` (5) × the number of columns of the list it belongs to — the cost of one `getFieldStats` per column, with no depth factor. The count is read in the `catalogMetadata` cache through the request's own loader (the resolver reuses that read): all columns of the schema for `getCatalogSchema`, the `fields` argument (or all columns) for `getFactTableWithMetadata { fields }`, every column of every schema for `getCatalogs { schemas { fields } }`, one entry per item of `groupBy` / `aggregates` for `getAggregates { groupBy { field } }` and `getAggregates { aggregates { field } }`, one column for a single Metadata (`getMetaData`) |
| `__schema`, `__type` | `INTROSPECTION_COST` (1000). An operation made only of introspection fields is exempted (development tools); in production introspection is off anyway. `__typename` is free                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Root field scores (`ROOT_FIELD_SCORES`):

| Score | Root fields                                                                           |
| ----- | ------------------------------------------------------------------------------------- |
| 1     | `_empty`, `getCatalogs` (configuration held in memory)                                |
| 2     | `getCatalogSchema`, `getDatasetInfo`, `getMetaData`, `getFields`                      |
| 3     | `getSharedFields`, `getSelectOptions`                                                 |
| 5     | `getFactTable`, `getFieldStats`, `getSelectOptionsTree`                               |
| 8     | `getFactTableWithMetadata`                                                            |
| 10    | `getAggregates` (plus its aggregates and group columns), `crossDatabaseSelectOptions` |
| 15    | `compareFacts`, `compareAggregatedFacts` (join of two datasets)                       |

Worked examples (locked by `tests/integration/complexity-guard.test.ts`):

| Operation                                                     | Score                   | Outcome                                           |
| ------------------------------------------------------------- | ----------------------- | ------------------------------------------------- |
| Full dashboard page (table, chart, options, tree, catalogs)   | ≈ 69                    | accepted                                          |
| `getAggregates`: 1 group column, 1 aggregate, `limit: 1`      | 10 + 3 + 2 + 0.1 = 15.1 | accepted                                          |
| `getAggregates`: 4 group columns, 20 `MEDIAN`, `limit: 1000`  | 10 + 12 + 140 + 100     | refused                                           |
| Three filtered `getFieldStats` (slider bounds)                | 21                      | accepted                                          |
| `getFactTableWithMetadata(limit: 1000) { columns data }`      | 108                     | accepted                                          |
| `getCatalogSchema { stats }` on a 16-column schema            | 2 + 80 = 82             | accepted                                          |
| `getCatalogSchema { stats }` on a 40-column schema            | 2 + 200 = 202           | refused                                           |
| `getCatalogs { schemas { fields { stats } } }`                | every column of the API | refused                                           |
| 50 aliased `compareFacts`                                     | 50 root fields          | refused                                           |
| 20 aliased `getAggregates(limit: 1000)`, 1 group, 1 aggregate | 20 × 115                | refused                                           |
| `getSelectOptions(limit: 1000000)`                            | 3 + 100 = 103           | accepted, then `BAD_USER_INPUT` from the resolver |

To read column bounds, call `getFieldStats` on the columns actually displayed rather than `stats` on a whole schema. A new root query is priced by adding one entry to `ROOT_FIELD_SCORES`.

## No text patterns, no value sanitization

The query text is never pattern-matched and values are never escaped. Filter values are bound parameters (`treeToSQL` produces `{ sql, params }`), identifiers (`fields`, `sort`, `groupBy`, `measure`, filter variables) are checked against the `metadata` table then quoted, mutations are refused by the operation-type check (the schema has no `Mutation` type) and introspection by Apollo's `NoIntrospection` rule when `API.GRAPHQL.INTROSPECTION` is false. A pattern applied to the raw text would protect nothing (the same value passes through variables) and would reject legitimate queries: `__typename` added by Apollo Client and urql, a search for "ecosystem", a column named `mutation_rate`.

## Security manager (`src/security/manager.ts`)

`SecurityManager` is the single entry point that orchestrates the rate limiters and the operation checks. `src/server.ts` creates one instance at startup, mounts its rate-limit middlewares and calls it from the Apollo lifecycle plugin.

## Error handling (`src/utils/graphql-errors.ts`)

Every error carries an `errorId` (UUID) in its `extensions`, logged once server-side with the `requestId` so incidents can be correlated: as a warning without stack trace for a client error, as an error with the stack of its cause otherwise. The stack trace is never sent to the client.

- **Client errors** keep their message in every environment: `BAD_USER_INPUT`, `SCHEMA_VERSION_UNSUPPORTED`, `QUERY_COMPLEXITY_EXCEEDED`, `GRAPHQL_VALIDATION_FAILED`, `GRAPHQL_PARSE_FAILED`, `BAD_REQUEST`, `OPERATION_RESOLUTION_FAILURE`, `PERSISTED_QUERY_NOT_FOUND`, `PERSISTED_QUERY_NOT_SUPPORTED`, `DEPTH_LIMIT_EXCEEDED`, `OPERATION_TYPE_NOT_ALLOWED`, `CROSS_DATABASE_DISABLED`.
- **Internal errors** (`INTERNAL_SERVER_ERROR`, and any code not listed above): in production the message is replaced by `An error occurred` and only `code` and `errorId` are sent; in development the message is kept.

```json
{
  "errors": [
    {
      "message": "Query too complex: score 202 exceeds the maximum of 200. Request fewer fields, reduce the nesting depth, lower the limit argument, or read column statistics with getFieldStats on the columns you display.",
      "extensions": {
        "code": "QUERY_COMPLEXITY_EXCEEDED",
        "complexity": 202,
        "maxAllowed": 200,
        "errorId": "3f2a1b…"
      }
    }
  ]
}
```
