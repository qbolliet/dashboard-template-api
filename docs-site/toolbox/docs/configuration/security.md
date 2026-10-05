---
title: security.yaml
sidebar_position: 4
---

# `config/security.yaml`

Controls all application-level security checks.

## Rate limiting

```yaml
SECURITY:
  RATE_LIMIT:
    MAX_REQUESTS: ${RATE_LIMIT_MAX_REQUESTS:-100}
    WINDOW_MS: ${RATE_LIMIT_WINDOW_MS:-900000} # 15 minutes
    MAX_BURST_REQUESTS: ${RATE_LIMIT_BURST:-20}
    BURST_WINDOW_MS: ${RATE_LIMIT_BURST_WINDOW:-60000} # 1 minute
    TRUSTED_PROXIES: ${TRUSTED_PROXIES:-[]}
```

Two independent sliding windows are applied per client IP on `/graphql` and `/api/export` (one shared budget):

| Window    | Default limit    | Purpose               |
| --------- | ---------------- | --------------------- |
| Sustained | 100 req / 15 min | Prevent data scraping |
| Burst     | 20 req / 1 min   | Prevent sudden spikes |

The client is identified by **its IP alone**. The User-Agent is not part of the key, so rotating it does not reset the budget. The flip side is that clients behind the same NAT share one budget.

### Trusted proxies (`TRUSTED_PROXIES`)

`TRUSTED_PROXIES` is the single source of Express's [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) setting. It is applied before any middleware, and `req.ip` is the client identity used by the rate limiters and by the export concurrency gate. Express walks `x-forwarded-for` from right to left, skips the trusted hops and keeps the **rightmost untrusted address**. Addresses a client prepends to the header are never used.

Accepted forms:

- a YAML list (`['127.0.0.1']`);
- the JSON string of an environment override (`TRUSTED_PROXIES='["10.0.0.0/8"]'`);
- a comma-separated string (`TRUSTED_PROXIES=10.0.0.0/8,127.0.0.1`).

Each entry is an IP, a CIDR block (`10.0.0.0/8`, `fc00::/7`) or a named range (`loopback`, `linklocal`, `uniquelocal`). `'*'` trusts every hop. It is not recommended, because any client reaching the API directly could then choose its IP. **An invalid entry stops the server at startup** rather than being silently ignored.

| Deployment                      | Expected value                                                              |
| ------------------------------- | --------------------------------------------------------------------------- |
| API exposed directly            | `[]` (default): `x-forwarded-for` is ignored                                |
| Local nginx / Caddy on the host | `['127.0.0.1']` or `['loopback']`                                           |
| Kubernetes, behind the ingress  | CIDR of the ingress controller pods, e.g. `'["10.0.0.0/8"]'` (Helm default) |

Behind the ingress, the TCP peer of the API is an ingress controller pod. It must be covered by the list, or every client is counted under that pod's IP. Narrow the CIDR to the pod network of your cluster when you can. If the ingress controller itself sits behind a load balancer, `x-forwarded-for` must carry the real client IP up to that point (for ingress-nginx: `use-forwarded-headers` / `compute-full-forwarded-for`), and the load balancer addresses must be trusted as well.

### Per-pod counters

Counters are kept **in memory, per process**. With `N` replicas, a client spread across pods by the load balancer can send up to `N ×` the configured limit, and a pod restart resets its counters. A Redis-backed shared store is a possible future evolution; it is not implemented.

## Admin endpoints

`/api/cache/*` and `/api/catalog/*` require the `x-admin-key` header, which must match `ADMIN_API_KEY`. When the variable is not set, these routes answer 503. The key is compared in constant time (`crypto.timingSafeEqual` on SHA-256 digests), and a repeated header is rejected.

These routes are behind a dedicated, strict limiter with a budget separate from the public one. It is mounted **before** the key check, so every attempt counts, including rejected keys:

```yaml
SECURITY:
  ADMIN_RATE_LIMIT:
    ENABLED: ${ADMIN_RATE_LIMIT_ENABLED:-true}
    MAX_REQUESTS: 10 # per IP and per minute
    WINDOW_MS: 60000
    MAX_BURST_REQUESTS: 10
    BURST_WINDOW_MS: 60000
```

The 11th request from one IP within a minute gets a `429` with `Retry-After`. The nightly data update no longer calls the admin routes (each pod detects it, see [Data refresh](../deployment/data-refresh)); an occasional manual `/api/catalog/reload` fits well within this budget. Raise it if you script many per-catalog reloads in a row. The counters are per pod, as for the public limiter.

## Operational endpoints

- `/health` and `/ready` are public (kubelet probes). `/ready` answers `{"status":"ready"}` (`200`), `{"status":"not_ready"}` (`503`, a dependency is down) or `{"status":"shutting_down"}` (`503`); the cause (pool, Redis error) is logged, never returned.
- `/metrics` is restricted. A caller passes when its address (`req.ip`, resolved through `TRUSTED_PROXIES`) is on `SECURITY.METRICS.ALLOWED_IPS`, or when it sends the `x-admin-key` header matching `ADMIN_API_KEY`. Anything else gets `401`, including when `ADMIN_API_KEY` is unset (the endpoint stays closed until the operator opens it).

```yaml
SECURITY:
  METRICS:
    # IPs or CIDR blocks allowed without key (YAML list, JSON string or comma-separated)
    ALLOWED_IPS: ${METRICS_ALLOWED_IPS:-[]} # e.g. METRICS_ALLOWED_IPS='["10.0.12.0/24"]'
```

Callers who must prove themselves with the key go through the admin limiter described above (every attempt counts); listed addresses skip it, so a scraper is never throttled. An invalid entry stops the server at startup. A Prometheus scraper either sits on the list or sends `x-admin-key` (a `ServiceMonitor` with `authorization`/`headers` from a Secret).

## Query complexity

```yaml
SECURITY:
  COMPLEXITY:
    MAX_ALLOWED: 200 # ceiling on the score of one operation
    MAX_ROOT_FIELDS: 20 # root fields per operation, aliases included
    SCALAR_COST: 0
    OBJECT_COST: 1
    DEPTH_FACTOR: 1.5
    INTROSPECTION_COST: 1000 # __schema and __type; __typename is free
    ROW_COST: 0.1 # per row of `limit`, bounded by API.PAGINATION.MAX_LIMIT
    STATS_COST_PER_COLUMN: 5 # Metadata.stats, per column of the enclosing list
    AGGREGATE_COST: 2 # getAggregates: per aggregate
    HOLISTIC_AGGREGATE_COST: 5 # getAggregates: extra per explicit MEDIAN or MODE
    GROUP_COLUMN_COST: 3 # getAggregates: per group column
    DEFAULT_ROOT_FIELD_SCORE: 5 # root field missing from the table
    ROOT_FIELD_SCORES:
      getCatalogs: 1
      getCatalogSchema: 2
      getSelectOptions: 3
      getFactTable: 5
      getFactTableWithMetadata: 8
      getAggregates: 10
      compareFacts: 15
      # … one entry per root field of the Query type
```

Every root field pays its score from `ROOT_FIELD_SCORES` (never zero), plus `ROW_COST` per requested row (an omitted `limit` is charged at its SDL default), +2 for a filter tree and +1 for a sort; `getAggregates` also pays `AGGREGATE_COST` per aggregate, `HOLISTIC_AGGREGATE_COST` per explicit `MEDIAN`/`MODE` and `GROUP_COLUMN_COST` per group column; nested objects pay `OBJECT_COST × DEPTH_FACTOR^depth`, and `Metadata.stats` pays `STATS_COST_PER_COLUMN` for each column of the list it belongs to. Operations with more than `MAX_ROOT_FIELDS` root fields, or a score above `MAX_ALLOWED`, are rejected before execution with `QUERY_COMPLEXITY_EXCEEDED` (HTTP 400). The full scale and worked examples are in [Security architecture](../architecture/security.md#complexity-scale-srcsecuritycomplexity-analyzerts).

Adding a root query means adding its entry to `ROOT_FIELD_SCORES`: `tests/integration/complexity-guard.test.ts` fails when a `Query` field has none.

## Query depth

```yaml
SECURITY:
  MAX_QUERY_DEPTH:
    development: 15
    production: 7
```

The maximum nesting depth of a GraphQL selection set. Deeply nested queries are rejected to prevent abuse.

## No input sanitization

There is no `SANITIZATION` section and no pattern file: filter values are bound parameters and identifiers are checked against the `metadata` table, so escaping values would only corrupt legitimate labels (« Côte-d'Or »), and patterns applied to the query text would reject legitimate queries (`__typename`, a search for "ecosystem") while the same value passes through variables. See [Security architecture](../architecture/security.md#no-text-patterns-no-value-sanitization).

## Monitoring

```yaml
SECURITY:
  MONITORING:
    SLOW_QUERY_THRESHOLD: ${SLOW_QUERY_THRESHOLD:-1000}
    LOG_ALL_METRICS: ${LOG_ALL_SECURITY_METRICS:-false}
```

Queries slower than `SLOW_QUERY_THRESHOLD` milliseconds are logged as warnings with their full context.
