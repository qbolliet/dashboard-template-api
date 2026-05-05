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

| Key | Env var | Default | Description |
|-----|---------|---------|-------------|
| `PORT` | `PORT` | `4000` | TCP port the server listens on |
| `DOMAIN` | `API_DOMAIN` | — | Public domain used for CORS and HSTS |

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

| Key | Default | Description |
|-----|---------|-------------|
| `MAX_REQUEST_SIZE` | `100kb` | Maximum HTTP request body size |
| `MAX_FIELD_SIZE` | `1000` | Maximum value length for a single form field |
| `MAX_FIELDS` | `50` | Maximum number of fields in a multipart form |

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

## Timeouts (ms)

Per-operation query timeouts:

| Operation | Default |
|-----------|---------|
| Simple fact query | 10 000 ms |
| Complex fact query | 15 000 ms |
| Simple aggregation | 10 000 ms |
| Complex aggregation | 15 000 ms |
| Dimension query | 5 000 ms |
| Metadata query | 5 000 ms |
| Select options | 5 000 ms |

Override via the corresponding env vars (`FACT_SIMPLE_TIMEOUT`, `FACT_COMPLEX_TIMEOUT`, …).

## Data loaders

```yaml
API:
  LOADERS:
    BATCH_SIZE: ${LOADER_BATCH_SIZE:-10}
    MAX_BATCH_SIZE: ${MAX_LOADER_BATCH_SIZE:-50}
    DEFAULT_CACHE_TIMEOUT: ${LOADER_CACHE_TIMEOUT:-300}
    FACT_CACHE_TIMEOUT: ${FACT_LOADER_CACHE_TIMEOUT:-300}
    DIMENSION_CACHE_TIMEOUT: ${DIMENSION_LOADER_CACHE_TIMEOUT:-600}
    METADATA_CACHE_TIMEOUT: ${METADATA_LOADER_CACHE_TIMEOUT:-600}
    SELECT_OPTIONS_CACHE_TIMEOUT: ${SELECT_OPTIONS_LOADER_CACHE_TIMEOUT:-600}
```

Loader cache timeouts (in seconds) control how long DataLoader caches keys in memory within a request. This is separate from the Redis cache.
