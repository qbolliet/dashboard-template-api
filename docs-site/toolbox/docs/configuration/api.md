---
title: api.yaml
sidebar_position: 2
---

# `config/api.yaml`

Controls the HTTP server and GraphQL runtime behaviour.

## Server

```yaml
API:
  PORT: ${PORT:-4000}
```

| Key    | Env var | Default | Description                    |
| ------ | ------- | ------- | ------------------------------ |
| `PORT` | `PORT`  | `4000`  | TCP port the server listens on |

## CORS

```yaml
API:
  CORS:
    CREDENTIALS: false
    METHODS: ['GET', 'POST', 'OPTIONS']
    HEADERS: ['Content-Type', 'Authorization']
    MAX_AGE: 86400
    ORIGINS:
      development:
        - 'https://studio.apollographql.com'
        - 'http://localhost:3000'
        - 'http://localhost:5173'
      production: ${CORS_ORIGINS:-[]}
```

Catalog and schema targeting is argument-only (`catalog` / `schema` GraphQL arguments) — the API never reads
routing information from request headers, so CORS only needs to allow `Content-Type` and `Authorization`.

`ORIGINS.production` is empty by default: no cross-origin request is allowed until `CORS_ORIGINS` is set, as a
JSON array (e.g. `CORS_ORIGINS='["https://qbolliet.github.io"]'`) or a comma-separated list of origins, one per
frontend that will query the API. `CREDENTIALS` stays `false` — the API is unauthenticated and never sets a
cookie, so `Access-Control-Allow-Credentials` is never sent.

## Request limits

```yaml
API:
  REQUEST_LIMITS:
    MAX_REQUEST_SIZE: '100kb'
    MAX_QUERY_SIZE: 20000
```

| Key                | Default | Description                                                     |
| ------------------ | ------- | --------------------------------------------------------------- |
| `MAX_REQUEST_SIZE` | `100kb` | Maximum raw HTTP request body size                              |
| `MAX_QUERY_SIZE`   | `20000` | Maximum length of the GraphQL document (`query`), in characters |

A request exceeding one of these limits is rejected with **HTTP 400** and a JSON body
`{ "errors": [{ "message": …, "extensions": { "code": … } }] }`, where `code` is
`REQUEST_BODY_TOO_LARGE` or `QUERY_TOO_LARGE`. Values inside `variables` are not bounded
one by one: filter values are bound parameters, the size of a filter tree is bounded by
`SECURITY.FILTER_TREE` (`MAX_CRITERIA`, `MAX_DEPTH`, `MAX_IN_VALUES`) and the whole body by
`MAX_REQUEST_SIZE`. Error messages that echo a client value truncate it to 80 characters.

## GraphQL introspection & playground

```yaml
API:
  GRAPHQL:
    INTROSPECTION:
      development: true
      production: false
    PLAYGROUND:
      development: true
      production: false
```

Introspection and Apollo Sandbox are disabled in production by default to reduce the attack surface.

## Pagination

```yaml
API:
  PAGINATION:
    DEFAULT_LIMIT: ${DEFAULT_PAGINATION_LIMIT:-100}
    MAX_LIMIT: ${MAX_PAGINATION_LIMIT:-1000}
    MAX_OFFSET: ${MAX_PAGINATION_OFFSET:-10000}
    SELECT_OPTIONS_LIMIT: ${SELECT_OPTIONS_LIMIT:-50}
```

## Aggregates (`getAggregates`)

```yaml
API:
  AGGREGATES:
    MAX_AGGREGATES: 20 # aggregates of one query
    MAX_GROUP_BY: 4 # group columns of one query
```

Above either bound, `getAggregates` answers `BAD_USER_INPUT` before any SQL. Each aggregate is one expression of the SELECT; each group column multiplies the number of possible groups. Their complexity cost is set in `config/security.yaml` (`AGGREGATE_COST`, `HOLISTIC_AGGREGATE_COST`, `GROUP_COLUMN_COST`).

## Export (`GET | POST /api/export`)

Guards of the bulk export endpoint (see [Bulk export](https://qbolliet.github.io/dashboard-template-api/api-guide/export)):

```yaml
API:
  EXPORT:
    MAX_ROWS: ${EXPORT_MAX_ROWS:-5000000}
    MAX_CONCURRENT_PER_IP: ${EXPORT_MAX_CONCURRENT_PER_IP:-2}
    MAX_CONCURRENT_TOTAL: ${EXPORT_MAX_CONCURRENT_TOTAL:-2}
    TIMEOUT_MS: ${EXPORT_TIMEOUT_MS:-120000}
    TRANSFER_TIMEOUT_MS: ${EXPORT_TRANSFER_TIMEOUT_MS:-600000}
    TMP_DIR: ${EXPORT_TMP_DIR:-}
    TMP_MIN_FREE_MB: ${EXPORT_TMP_MIN_FREE_MB:-1024}
```

| Key                     | Description                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_ROWS`              | Row ceiling of one response; a larger `limit` is capped. Beyond it: `413` without `limit`, `X-Truncated` + `X-Next-After` with it.         |
| `MAX_CONCURRENT_PER_IP` | In-flight exports per client IP (`429` beyond).                                                                                            |
| `MAX_CONCURRENT_TOTAL`  | In-flight exports overall. Keep it below `DATABASE.POOL.MAX_CONNECTIONS` so that GraphQL keeps connections of its own.                     |
| `TIMEOUT_MS`            | Budget until the first byte (count, query and COPY; stream opening for Arrow): the query is interrupted, `504`.                            |
| `TRANSFER_TIMEOUT_MS`   | Budget from the first byte to the end. A client too slow to read the file has its connection closed. For Arrow it covers the whole stream. |
| `TMP_DIR`               | Directory of the csv/parquet temporary files; empty = `<system tmp>/dashboard-api-export`.                                                 |
| `TMP_MIN_FREE_MB`       | Free space the `TMP_DIR` volume must keep; below it a csv/parquet export is refused with `507`. `0` disables the check.                    |

## Graceful shutdown

```yaml
API:
  SHUTDOWN:
    TIMEOUT_MS: ${SHUTDOWN_TIMEOUT_MS:-25000}
```

Overall budget (ms) of the shutdown on `SIGTERM`/`SIGINT`: drain of the in-flight requests and exports, then closing of the pool and Redis. When it elapses the process exits with code `1`. Keep it **below** `terminationGracePeriodSeconds` (Helm: `terminationGracePeriodSeconds` and `config.SHUTDOWN_TIMEOUT_MS`, checked at render time). See [Architecture overview](../architecture/overview.md#graceful-shutdown).

## Timeouts (ms)

Per-operation query timeouts:

| Operation           | Default   |
| ------------------- | --------- |
| Simple fact query   | 10 000 ms |
| Complex fact query  | 15 000 ms |
| Simple aggregation  | 10 000 ms |
| Complex aggregation | 15 000 ms |
| Metadata query      | 5 000 ms  |
| Select options      | 5 000 ms  |

Override via the corresponding env vars (`FACT_SIMPLE_TIMEOUT`, `FACT_COMPLEX_TIMEOUT`, …).

## Data loaders

```yaml
API:
  LOADERS:
    BATCH_SIZE: ${LOADER_BATCH_SIZE:-10}
    DEFAULT_CACHE_TIMEOUT: ${LOADER_CACHE_TIMEOUT:-300}
    FACT_CACHE_TIMEOUT: ${FACT_LOADER_CACHE_TIMEOUT:-300}
    METADATA_CACHE_TIMEOUT: ${METADATA_LOADER_CACHE_TIMEOUT:-600}
    SELECT_OPTIONS_CACHE_TIMEOUT: ${SELECT_OPTIONS_LOADER_CACHE_TIMEOUT:-600}
```

The `*_CACHE_TIMEOUT` values (in seconds) are the TTLs of the Redis entries written by each loader (see [Caching](../architecture/caching)). The DataLoader cache itself is request-scoped and has no TTL.
