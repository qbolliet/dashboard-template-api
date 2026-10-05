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

| Key          | Env var            | Default        | Description                                       |
| ------------ | ------------------ | -------------- | ------------------------------------------------- |
| `HOST`       | `REDIS_HOST`       | `localhost`    | Redis server hostname                             |
| `PORT`       | `REDIS_PORT`       | `6379`         | Redis server port                                 |
| `PASSWORD`   | `REDIS_PASSWORD`   | —              | Redis AUTH password (leave unset if not required) |
| `DB`         | `REDIS_DB`         | `0`            | Redis logical database index                      |
| `KEY_PREFIX` | `REDIS_KEY_PREFIX` | `graphql-api:` | Namespace prefix for all cache keys               |

### Redis Cluster

```yaml
CACHE:
  REDIS:
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

The TTL of a Redis entry is set by the loader that writes it, from `API.LOADERS` in [`config/api.yaml`](./api#data-loaders):

| Data type                      | Key                            | Default TTL    |
| ------------------------------ | ------------------------------ | -------------- |
| Facts, aggregates, comparisons | `FACT_CACHE_TIMEOUT`           | 300 s (5 min)  |
| Metadata                       | `METADATA_CACHE_TIMEOUT`       | 600 s (10 min) |
| Select options, field stats    | `SELECT_OPTIONS_CACHE_TIMEOUT` | 600 s          |
| Catalog and dataset info       | `DEFAULT_CACHE_TIMEOUT`        | 300 s          |

## Cache invalidation

`cache.yaml` has no invalidation setting. A catalog update needs none: cache keys carry the data version each pod serves (`<type>:<catalog>:<schema>@<version>:…`), so they move on their own when a pod picks the update up (see [Caching](../architecture/caching#versioned-namespaces)). The admin routes `POST /api/cache/invalidate-all` and `POST /api/cache/invalidate/:catalog[/:schema]` flush manually, with a non-blocking `SCAN` + `DEL`. After a code deployment, see [Kubernetes & Helm](../deployment/kubernetes-helm#after-a-code-deployment-flush-the-cache).

See the [Data refresh deployment guide](../deployment/data-refresh) for the full update workflow.

## HTTP cache headers

None are configured. Apollo answers `/graphql` with `Cache-Control: no-store`, so no CDN or browser caches a GraphQL response; only Redis does.
