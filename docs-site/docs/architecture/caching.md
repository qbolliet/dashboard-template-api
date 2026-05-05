---
title: Caching
sidebar_position: 3
---

# Caching

The API uses two independent caching layers:

| Layer | Scope | Implementation |
|-------|-------|---------------|
| DataLoader cache | Single request | In-memory, per-request |
| Redis cache | Cross-request | Redis with per-type TTL |

## DataLoader cache (request-scoped)

Each incoming GraphQL request receives a fresh set of DataLoader instances (created in the Apollo context factory). Within that request, identical DB calls — for example, multiple fields requesting the same dimension value — are:

1. **Batched** into a single SQL query
2. **Deduplicated** so the same key is only fetched once per batch

The DataLoader cache lives only for the duration of the request. It prevents N+1 queries within a single operation but does not persist across requests.

Loader cache timeouts (in-memory, not Redis) are configured per data type in `config/api.yaml`:

| Loader | Default in-memory TTL |
|--------|-----------------------|
| Facts | 300 s |
| Dimensions | 600 s |
| Metadata | 600 s |
| Select options | 600 s |

## Redis cache (cross-request)

Resolver results are cached in Redis with keys derived from the query parameters. On cache hit, the resolver returns the cached value without touching DuckDB.

TTL values per data type (`config/cache.yaml`):

| Type | Default TTL |
|------|-------------|
| Facts | 300 s |
| Aggregated facts | 300 s |
| Dimensions | 600 s |
| Metadata | 600 s |
| Select options | 600 s |

All cache keys are prefixed with `REDIS_KEY_PREFIX` (`graphql-api:` by default) to allow coexistence with other apps in the same Redis instance.

## Cache invalidation

When a DuckLake file is updated, the cache must be invalidated to prevent stale data. Two mechanisms are provided:

### Manual invalidation

```bash
npm run db:update           # handles a database update event + invalidates cache
npm run db:update:dry       # dry run — shows what would be invalidated
npm run db:invalidate       # force-invalidate all cache keys immediately
```

### Automatic invalidation

When `CACHE_AUTO_INVALIDATE=true` (default), the `handle-database-update.js` script:

1. Waits `GRACE_PERIOD` seconds (60 s default) for in-flight queries to drain
2. Deletes all cache keys matching the updated catalog's prefix in batches of `BATCH_SIZE`
3. Times out after `TIMEOUT` ms if invalidation takes too long

### Graceful invalidation flow

```
DB file updated
  │
  ├─ Wait GRACE_PERIOD seconds
  │
  ├─ Delete cache keys in batches (BATCH_SIZE)
  │
  └─ Log success / timeout
```

See `docs/DATABASE_UPDATES.md` for the full operational procedure.

## HTTP cache headers

Express adds `Cache-Control: public` headers for responses from `/graphql`, enabling CDN and browser caching:

```
Cache-Control: public, max-age=300
Vary: accept-encoding, accept
```

`max-age` mirrors the Redis TTL for the queried data type. CDN layers (Cloudflare, Fastly, etc.) can cache responses without any additional configuration.
