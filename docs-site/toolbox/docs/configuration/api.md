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
  DOMAIN: ${API_DOMAIN:-'https://your-production-domain.com'}
```

| Key      | Env var      | Default | Description                          |
| -------- | ------------ | ------- | ------------------------------------ |
| `PORT`   | `PORT`       | `4000`  | TCP port the server listens on       |
| `DOMAIN` | `API_DOMAIN` | —       | Public domain used for CORS and HSTS |

## CORS

```yaml
API:
  CORS:
    CREDENTIALS: true
    METHODS: ['GET', 'POST', 'OPTIONS']
    HEADERS: ['Content-Type', 'Authorization']
    ORIGINS:
      development:
        - 'https://studio.apollographql.com'
        - 'http://localhost:3000'
        - 'http://localhost:5173'
      production:
        - ${API_DOMAIN:-'https://your-production-domain.com'}
```

Add allowed origins to the `production` list for each frontend that will query the API.

## Request limits

```yaml
API:
  REQUEST_LIMITS:
    MAX_REQUEST_SIZE: ${MAX_REQUEST_SIZE:-'100kb'}
    MAX_FIELD_SIZE: ${MAX_FIELD_SIZE:-1000}
    MAX_FIELDS: ${MAX_FIELDS:-50}
```

| Key                | Default | Description                                  |
| ------------------ | ------- | -------------------------------------------- |
| `MAX_REQUEST_SIZE` | `100kb` | Maximum HTTP request body size               |
| `MAX_FIELD_SIZE`   | `1000`  | Maximum value length for a single form field |
| `MAX_FIELDS`       | `50`    | Maximum number of fields in a multipart form |

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

## Export (`GET /api/export`)

Guards of the bulk export endpoint (see [Bulk export](https://qbolliet.github.io/dashboard-template-api/api-guide/export)):

```yaml
API:
  EXPORT:
    MAX_ROWS: ${EXPORT_MAX_ROWS:-5000000}
    MAX_CONCURRENT_PER_IP: ${EXPORT_MAX_CONCURRENT_PER_IP:-2}
    MAX_CONCURRENT_TOTAL: ${EXPORT_MAX_CONCURRENT_TOTAL:-2}
    TIMEOUT_MS: ${EXPORT_TIMEOUT_MS:-120000}
    TMP_DIR: ${EXPORT_TMP_DIR:-}
```

| Key                     | Description                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MAX_ROWS`              | Row ceiling, applied as a `LIMIT`; a larger `limit` parameter is capped.                                               |
| `MAX_CONCURRENT_PER_IP` | In-flight exports per client IP (`429` beyond).                                                                        |
| `MAX_CONCURRENT_TOTAL`  | In-flight exports overall. Keep it below `DATABASE.POOL.MAX_CONNECTIONS` so that GraphQL keeps connections of its own. |
| `TIMEOUT_MS`            | Maximum export duration: the query is interrupted and the stream ended.                                                |
| `TMP_DIR`               | Directory of the csv/parquet temporary files; empty = `<system tmp>/dashboard-api-export`.                             |

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
    MAX_BATCH_SIZE: ${MAX_LOADER_BATCH_SIZE:-50}
    DEFAULT_CACHE_TIMEOUT: ${LOADER_CACHE_TIMEOUT:-300}
    FACT_CACHE_TIMEOUT: ${FACT_LOADER_CACHE_TIMEOUT:-300}
    METADATA_CACHE_TIMEOUT: ${METADATA_LOADER_CACHE_TIMEOUT:-600}
    SELECT_OPTIONS_CACHE_TIMEOUT: ${SELECT_OPTIONS_LOADER_CACHE_TIMEOUT:-600}
```

Loader cache timeouts (in seconds) control how long DataLoader caches keys in memory within a request. This is separate from the Redis cache.
