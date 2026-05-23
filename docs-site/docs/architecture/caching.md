---
title: Caching
sidebar_position: 3
---

# Caching

The API uses two independent caching layers:

| Layer            | Scope          | Implementation          |
| ---------------- | -------------- | ----------------------- |
| DataLoader cache | Single request | In-memory, per-request  |
| Redis cache      | Cross-request  | Redis with per-type TTL |

## DataLoader cache (request-scoped)

Each incoming GraphQL request receives a fresh set of DataLoader instances (created in the Apollo context factory). Within that request, identical DB calls — for example, multiple fields requesting the same dimension value — are:

1. **Batched** into a single SQL query
2. **Deduplicated** so the same key is only fetched once per batch

The DataLoader cache lives only for the duration of the request. It prevents N+1 queries within a single operation but does not persist across requests.

Loader cache timeouts (in-memory, not Redis) are configured per data type in `config/api.yaml`:

| Loader         | Default in-memory TTL |
| -------------- | --------------------- |
| Facts          | 300 s                 |
| Dimensions     | 600 s                 |
| Metadata       | 600 s                 |
| Select options | 600 s                 |

## Redis cache (cross-request)

Resolver results are cached in Redis with keys derived from the query parameters. On cache hit, the resolver returns the cached value without touching DuckDB.

TTL values per data type (`config/cache.yaml`):

| Type             | Default TTL |
| ---------------- | ----------- |
| Facts            | 300 s       |
| Aggregated facts | 300 s       |
| Dimensions       | 600 s       |
| Metadata         | 600 s       |
| Select options   | 600 s       |

All cache keys are prefixed with `REDIS_KEY_PREFIX` (`graphql-api:` by default) to allow coexistence with other apps in the same Redis instance.

## Cache invalidation

When a DuckLake file is updated, the cache must be invalidated to prevent stale data. The API exposes three admin-protected HTTP endpoints (`POST /api/cache/invalidate-all`, `POST /api/cache/invalidate/:database`, `GET /api/cache/stats`) that perform a non-blocking Redis `SCAN` + `DEL` over the per-database key namespaces.

See the [Data refresh deployment guide](../deployment/data-refresh) for endpoint reference, in-cluster `CronJob` patterns, the Python updater example, monitoring and troubleshooting.

## HTTP cache headers

Express adds `Cache-Control: public` headers for responses from `/graphql`, enabling CDN and browser caching:

```
Cache-Control: public, max-age=300
Vary: accept-encoding, accept
```

`max-age` mirrors the Redis TTL for the queried data type. CDN layers (Cloudflare, Fastly, etc.) can cache responses without any additional configuration.
