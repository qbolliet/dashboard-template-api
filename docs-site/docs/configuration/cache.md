---
title: cache.yaml
sidebar_position: 5
---

# `config/cache.yaml`

Controls Redis connection and result cache behaviour.

## Redis connection

```yaml
CACHE:
  REDIS:
    HOST: ${REDIS_HOST:-localhost}
    PORT: ${REDIS_PORT:-6379}
    PASSWORD: ${REDIS_PASSWORD}
    DB: ${REDIS_DB:-0}
    KEY_PREFIX: ${REDIS_KEY_PREFIX:-'graphql-api:'}
```

| Key | Env var | Default | Description |
|-----|---------|---------|-------------|
| `HOST` | `REDIS_HOST` | `localhost` | Redis server hostname |
| `PORT` | `REDIS_PORT` | `6379` | Redis server port |
| `PASSWORD` | `REDIS_PASSWORD` | — | Redis AUTH password (leave unset if not required) |
| `DB` | `REDIS_DB` | `0` | Redis logical database index |
| `KEY_PREFIX` | `REDIS_KEY_PREFIX` | `graphql-api:` | Namespace prefix for all cache keys |

### Redis Cluster

```yaml
CACHE:
  REDIS:
    OPTIONS:
      CLUSTER:
        ENABLED: ${REDIS_CLUSTER:-false}
        NODES:
          - host: ${REDIS_NODE1_HOST:-localhost}
            port: ${REDIS_NODE1_PORT:-6379}
          - host: ${REDIS_NODE2_HOST:-localhost}
            port: ${REDIS_NODE2_PORT:-6380}
```

Set `REDIS_CLUSTER=true` and configure `REDIS_NODE*` variables to use Redis Cluster mode.

## TTL values (seconds)

```yaml
CACHE:
  TTL:
    DEFAULT: 300
    METADATA: 600
    DIMENSIONS: 600
    FACTS: 300
    AGGREGATED_FACTS: 300
    SELECT_OPTIONS: 600
    COUNT_QUERIES: 300
```

| Data type | Default TTL |
|-----------|-------------|
| Metadata | 600 s (10 min) |
| Dimensions | 600 s |
| Facts | 300 s (5 min) |
| Aggregated facts | 300 s |
| Select options | 600 s |
| Count queries | 300 s |

## Cache invalidation

```yaml
CACHE:
  INVALIDATION:
    GRACE_PERIOD: ${CACHE_INVALIDATION_GRACE_PERIOD:-60}
    AUTO_INVALIDATE: ${CACHE_AUTO_INVALIDATE:-true}
    BATCH_SIZE: ${CACHE_INVALIDATION_BATCH_SIZE:-1000}
    TIMEOUT: ${CACHE_INVALIDATION_TIMEOUT:-30000}
```

When a DuckLake file is updated (e.g. a new dataset is loaded), a `POST` to `/api/cache/invalidate-all` (or `/api/cache/invalidate/:database`):
1. Waits `GRACE_PERIOD` seconds for in-flight queries to complete
2. Deletes all matching cache keys in batches of `BATCH_SIZE`
3. Times out if invalidation takes longer than `TIMEOUT` ms

See the [Cache invalidation deployment guide](../deployment/cache-invalidation) for the full update workflow.

## HTTP cache headers

```yaml
CACHE:
  HTTP_CACHE:
    PUBLIC_PATHS: ['/graphql']
    VARY_BY_HEADERS: ['accept-encoding', 'accept']
```

Responses from the paths listed in `PUBLIC_PATHS` receive `Cache-Control: public` headers, enabling CDN caching.
