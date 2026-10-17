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

Each incoming GraphQL request receives a fresh set of DataLoader instances (created in the Apollo context factory). Within that request, identical DB calls — for example, multiple fields requesting the same column metadata — are:

1. **Batched** into a single SQL query
2. **Deduplicated** so the same key is only fetched once per batch

The DataLoader cache lives only for the duration of the request. It prevents N+1 queries within a single operation but does not persist across requests.

## Redis cache (cross-request)

Resolver results are cached in Redis with keys derived from the query parameters. On cache hit, the resolver returns the cached value without touching DuckDB.

TTL values per data type (`API.LOADERS` in `config/api.yaml`, see [cache.yaml](../configuration/cache#ttl-values-seconds)):

| Type                           | Default TTL |
| ------------------------------ | ----------- |
| Facts, aggregates, comparisons | 300 s       |
| Metadata                       | 600 s       |
| Select options, field stats    | 600 s       |

All cache keys are prefixed with `REDIS_KEY_PREFIX` (`graphql-api:` by default) to allow coexistence with other apps in the same Redis instance.

## Versioned namespaces

Every key is built by `BaseQueryLoader.loadWithCache` through
[`src/cache/cache-keys.ts`](https://github.com/qbolliet/dashboard-template-api/blob/main/src/cache/cache-keys.ts):

```
<type>:<catalog>:<schema>@<version>:<variant><hash>
facts:macroeconomics:main@1790563200000000:with-count:3f2a…
```

- `<catalog>` and `<schema>` are always resolved (never a placeholder), so the invalidation
  patterns match every entry.
- `<version>` is the data version the pod **serves** for that schema:
  `epoch_us(dataset_metadata.updated_at)`, read on the live DuckDB instance at startup and
  after every reload (`none` when unreadable).
- A key reading several schemas (cross-catalog comparison) versions each side:
  `a+b:s1@<v1>+s2@<v2>`, so an update of either side moves it.
- `<hash>` is the sha1 of the canonical key object (sorted fields, `undefined` dropped).

When a catalog update is detected (see
[Data refresh](../deployment/data-refresh#how-a-replica-sees-an-update)), each pod rebuilds
its instance and then publishes the new version: its reads and writes move to new keys, and
entries computed on older data are never read again — no `SCAN`, no `DEL`. They expire by
their TTL, so Redis briefly holds both versions. A pod that has not switched yet keeps using
the old keys, which is consistent with the old data it still serves; the new version is
published only once the retired instance is drained, so old data can never be written under
a new-version key.

Adding or removing a schema is detected by the same probe and needs no invalidation either:
a new schema gets its own keys from its first query, and the keys of a dropped schema are
never read again and expire by their TTL.

## Cache invalidation

A catalog update — new data, a schema added or removed — does not require any
invalidation. The admin-protected endpoints remain
for a manual flush (`POST /api/cache/invalidate-all`, `POST /api/cache/invalidate/:catalog`,
`POST /api/cache/invalidate/:catalog/:schema`, `GET /api/cache/stats`): a non-blocking Redis
`SCAN` + `DEL` over the per-(catalog, schema) patterns, which match every data version
(`*:<catalog>:<schema>@*:*`, or `*:<catalog>:*:*` for a whole catalog).

See the [Data refresh deployment guide](../deployment/data-refresh) for the refresh model,
the endpoint reference, monitoring and troubleshooting.

### After a code deployment

Redis keys are versioned by the data, not by the code. A deployment that changes the content of a response for the same arguments would keep serving the old entries until their TTL. Once the rollout is complete, flush with `POST /api/cache/invalidate-all` (`x-admin-key` header); the exact step is in [Kubernetes & Helm](../deployment/kubernetes-helm#after-a-code-deployment-flush-the-cache). Calling it during the rollout is not enough: old pods would write their entries again.

## HTTP cache headers

Apollo answers `/graphql` with `Cache-Control: no-store`: no CDN or browser caches a GraphQL response, so a data update is visible as soon as Redis serves it.
