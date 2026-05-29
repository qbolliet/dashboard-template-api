---
title: Data refresh
sidebar_position: 4
---

# Data refresh

When DuckLake catalogs are refreshed (typically by a nightly external process), the API must do **two** things before subsequent queries see the new data:

1. **Reload the catalog** — the API attaches each DuckLake catalog to a single in-memory DuckDB instance **once, at startup**, and keeps that instance for the whole process lifetime. A running pod therefore keeps serving the snapshot it attached; it does **not** pick up a refreshed catalog automatically. `POST /api/catalog/reload` rebuilds the instance against the latest catalog (on disk or S3).
2. **Invalidate the Redis cache** — Redis is an external service that survives both the catalog reload and any pod restart. Until it is flushed, the API keeps serving cached results computed from the old catalog.

The order matters: **reload first, invalidate second** (see [Refresh sequence](#refresh-sequence)).

The API is responsible for catalog and cache state. The external updater is only responsible for refreshing DuckLake files and triggering reload + invalidation via HTTP — no shared filesystem or shared library is needed.

:::caution Why a reload is required
Because the catalog is attached once and held in memory, invalidating Redis alone is not enough: the next query repopulates the cache from the **same stale in-memory catalog**.
:::

## Architecture

After refreshing the DuckLake files, the external updater drives the two refresh steps through authenticated endpoints, **in order**: first a reload (full `/api/catalog/reload` or per-catalog `/api/catalog/reload/:catalog`), then a cache invalidation at the matching granularity — all catalogs, one catalog, or one (catalog, schema) pair.

```
┌─────────────────────┐        ┌────────────────────────────────────────────────┐
│ External updater    │        │  API (Kubernetes / Docker)                     │
│ (Python script,     │        │                                                │
│  cron, CI job…)     │  ①──▶  │  POST /api/catalog/reload                      │
│                     │        │  POST /api/catalog/reload/:catalog              │
│  1. Refresh         │        │  ┌────────────────────────────────────────┐    │
│     DuckLake        │        │  │ Full rebuild (all catalogs)            │    │
│  2. Reload catalog  │        │  │ or DETACH+ATTACH one catalog           │    │
│  3. Invalidate      │        │  └────────────────────────────────────────┘    │
│     cache           │        │                                                │
│                     │  ②──▶  │  POST /api/cache/invalidate-all                │
│                     │        │  POST /api/cache/invalidate/:catalog           │
│                     │        │  POST /api/cache/invalidate/:catalog/:schema   │
│                     │        │  ┌────────────────────────────────────────┐    │
│                     │        │  │ Redis SCAN + DEL                       │    │
│                     │        │  │ all catalogs · one catalog ·           │    │
│                     │        │  │ one (catalog, schema) pair             │    │
│                     │        │  └────────────────────────────────────────┘    │
└─────────────────────┘        └────────────────────────────────────────────────┘
```

Step ① rebuilds the shared in-memory DuckDB instance — either all catalogs at once (`/reload`) or a single catalog (`/reload/:catalog`) — so the updated catalog is served (the swap is zero-interruption — see [Endpoints](#endpoints)). Step ② then flushes Redis at the appropriate granularity — all catalogs, one catalog, or one (catalog, schema) pair — so cache misses recompute against the freshly attached catalog.

Cache isolation is per (catalog, schema): each (catalog, schema) pair has its own Redis key namespace, so invalidating one never affects another. Invalidation is a non-blocking `SCAN` + `DEL` pass over the per-(catalog, schema) key patterns:

```
metadata:<catalog>:<schema>:*
dimension:<catalog>:<schema>:*
dimension-value:<catalog>:<schema>:*
facts:<catalog>:<schema>:*
aggregated-facts:<catalog>:<schema>:*
select-options:<catalog>:<schema>:*
```

Invalidating a whole catalog uses the same patterns with `<schema>` replaced by `*` (e.g. `metadata:<catalog>:*:*`), so every schema is swept in one pass.

The implementation lives in [`src/cache/cache-invalidation.ts`](https://github.com/qbolliet/dashboard-template-api/blob/main/src/cache/cache-invalidation.ts).

## Endpoints

All admin endpoints require the `x-admin-key` header set to `ADMIN_API_KEY`. Without a valid key every endpoint returns `401`. If `ADMIN_API_KEY` is unset on the server, every endpoint returns `503` (fail-safe — invalidation cannot run on an unauthenticated deployment).

| Method | Path                                     | Purpose                                                                                                                          |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/catalog/reload`                    | Rebuild the in-memory DuckDB instance and re-attach all catalogs at their latest state. Resolves once the new catalog is serving |
| `POST` | `/api/catalog/reload/:catalog`           | Reattach a **single** catalog (scoped `DETACH` + `ATTACH`) without rebuilding the whole instance                                 |
| `POST` | `/api/cache/invalidate-all`              | Invalidate every catalog namespace                                                                                               |
| `POST` | `/api/cache/invalidate/:catalog`         | Invalidate one catalog, **every** of its schemas                                                                                 |
| `POST` | `/api/cache/invalidate/:catalog/:schema` | Invalidate one schema of one catalog — leaves the catalog's other schemas untouched                                              |
| `GET`  | `/api/cache/stats`                       | Nested `catalog → schema → type` cache key counts                                                                                |

`/api/catalog/reload` rebuilds the shared instance with zero interruption: the new instance is built first (if it fails — S3 unreachable, corrupt catalog — the old one keeps serving and the call returns `500`), then swapped in atomically, then the old instance is drained in the background so in-flight requests finish cleanly.

### Reloading a single catalog

When only one catalog has been refreshed, `POST /api/catalog/reload/:catalog` reattaches just that catalog on the **live** shared instance — a scoped `DETACH "<catalog>"` followed by its `ATTACH` (the Postgres credential secret is recreated automatically for Postgres-backed catalogs). The other catalogs are untouched, so this is cheaper than a full reload. Calls are serialized per catalog. An unknown catalog returns `404`.

Because all catalogs share one in-memory DuckDB instance, a query already running against **that** catalog during the brief `DETACH`/`ATTACH` window may error; queries on other catalogs are unaffected. This is an admin-triggered, low-frequency operation, so the tradeoff is accepted — sequence a per-catalog cache invalidation afterwards:

```bash
curl -fsS -X POST -H "x-admin-key: $ADMIN_API_KEY" \
  https://api.mydomain.org/api/catalog/reload/macroeconomics
curl -fsS -X POST -H "x-admin-key: $ADMIN_API_KEY" \
  https://api.mydomain.org/api/cache/invalidate/macroeconomics
```

A multi-schema catalog (a `.ducklake` holding several schemas) is reattached as a whole — reload is always catalog-level because schemas live inside the catalog file. Cache invalidation, on the other hand, is **finer-grained**: `POST /api/cache/invalidate/:catalog/:schema` flushes only the targeted schema without disturbing the catalog's other schemas, which is useful when an external process refreshes a single schema and a full per-catalog flush would over-invalidate.

## Refresh sequence

After the external process has finished writing the new DuckLake catalog and data, run the two admin calls **in this order**:

```
1. Updater writes new DuckLake catalog + Parquet (to disk or S3)
2. POST /api/catalog/reload          ← wait for 200 (new catalog now serving)
3. POST /api/cache/invalidate-all    ← only after the reload returns
```

Reloading **before** invalidating guarantees that when Redis is flushed, every cache miss is recomputed against the new catalog. If you invalidated first, an incoming request could repopulate the cache from the old in-memory catalog during the window before the reload completes.

## Calling from outside the cluster

When the updater runs outside the Kubernetes cluster (a managed CI job, a script on a separate host, an on-prem worker), it reaches the API through the Ingress URL.

### Python

```python
import os
import requests

API_URL = os.environ["DTA_API_URL"]                 # e.g. https://api.mydomain.org
ADMIN_KEY = os.environ["DTA_ADMIN_KEY"]
HEADERS = {"x-admin-key": ADMIN_KEY}

# After refreshing DuckLake catalogs:
# 1. Reload the catalog (the API holds it in memory until told otherwise).
#    Use a generous timeout: this re-attaches every catalog (S3 reads).
r = requests.post(f"{API_URL}/api/catalog/reload", headers=HEADERS, timeout=120)
r.raise_for_status()

# 2. Only once the reload succeeded, flush Redis so misses recompute on new data.
r = requests.post(f"{API_URL}/api/cache/invalidate-all", headers=HEADERS, timeout=30)
r.raise_for_status()
print(r.json())   # {"success": true, ...}
```

Per-catalog invalidation (flushes every schema of the catalog):

```python
for catalog in ("default", "macroeconomics"):
    requests.post(
        f"{API_URL}/api/cache/invalidate/{catalog}",
        headers={"x-admin-key": ADMIN_KEY},
        timeout=30,
    ).raise_for_status()
```

Per-schema invalidation (single catalog × schema, other schemas untouched):

```python
# Only the macroeconomics catalog's "annual" schema is flushed.
requests.post(
    f"{API_URL}/api/cache/invalidate/macroeconomics/annual",
    headers={"x-admin-key": ADMIN_KEY},
    timeout=30,
).raise_for_status()
```

### bash / cron

```bash
# Reload the catalog first, then invalidate the cache.
curl -fsS -X POST -H "x-admin-key: $ADMIN_API_KEY" \
  https://api.mydomain.org/api/catalog/reload
curl -fsS -X POST -H "x-admin-key: $ADMIN_API_KEY" \
  https://api.mydomain.org/api/cache/invalidate-all
```

A typical crontab entry on the host running the updater (note the `&&` chain so
the cache is only flushed once the refresh and reload succeed):

```cron
30 2 * * *  /usr/local/bin/refresh-ducklake.sh && \
            curl -fsS -X POST -H "x-admin-key: $ADMIN_API_KEY" \
              https://api.mydomain.org/api/catalog/reload && \
            curl -fsS -X POST -H "x-admin-key: $ADMIN_API_KEY" \
              https://api.mydomain.org/api/cache/invalidate-all \
            >> /var/log/dta-cache-invalidate.log 2>&1
```

## Calling from inside the cluster

When the DuckLake updater already runs inside the same Kubernetes cluster as the API — which is the most common production layout — there is no reason to traverse the Ingress. The Helm chart provisions a `Service` of type `ClusterIP` (port `80` → container port `4000`) that resolves via the cluster DNS:

```
http://<release-name>.<namespace>.svc.cluster.local:80/api/cache/invalidate-all
```

Inside the same namespace, the short form `http://<release-name>:80/...` (default release name `api` → `http://api:80/...`) works as well. No TLS, no Ingress traversal, and the admin key never leaves the cluster network.

`ADMIN_API_KEY` lives in the `api-secrets` Secret created at install time (see [Kubernetes & Helm](./kubernetes-helm)). Any Pod in the same namespace can mount it via `envFrom: secretRef`.

### CronJob

A minimal `CronJob` that runs the refresh script and then invalidates the cache:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ducklake-refresh
  namespace: dta
spec:
  schedule: '30 2 * * *'
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: refresh-and-invalidate
              image: curlimages/curl:8.10.1
              envFrom:
                - secretRef:
                    name: api-secrets # provides ADMIN_API_KEY
              command: ['/bin/sh', '-c']
              args:
                - >
                  set -eu;
                  echo "Refreshing DuckLake catalogs...";
                  # ...your DuckLake refresh step here...
                  echo "Reloading catalog...";
                  curl -fsS -X POST
                  -H "x-admin-key: $ADMIN_API_KEY"
                  http://api:80/api/catalog/reload;
                  echo "Invalidating cache...";
                  curl -fsS -X POST
                  -H "x-admin-key: $ADMIN_API_KEY"
                  http://api:80/api/cache/invalidate-all;
```

Replace `image: curlimages/curl` with your own updater image when the refresh step is non-trivial — the only requirement is that the container can reach the API Service and read `ADMIN_API_KEY` from `envFrom`.

To trigger a one-off run from the same template:

```bash
kubectl --namespace dta create job --from=cronjob/ducklake-refresh manual-$(date +%s)
```

### Python (in-cluster application)

For a Python updater running as a `Deployment`, `Job`, or `CronJob` Pod inside the cluster, the code is identical to the external version — only the URL changes:

```python
import os
import requests

# Resolved via cluster DNS — same namespace as the API release named "api"
API_URL = os.environ.get("DTA_API_URL", "http://api:80")
ADMIN_KEY = os.environ["ADMIN_API_KEY"]      # injected via envFrom: secretRef: api-secrets

def refresh_and_invalidate(databases: list[str] | None = None) -> None:
    """Refresh DuckLake catalogs, reload the API catalog, then invalidate cache."""
    headers = {"x-admin-key": ADMIN_KEY}

    refresh_ducklake_catalogs(databases)     # your own logic

    # Reload the in-memory catalog first (rebuilds the shared DuckDB instance).
    requests.post(f"{API_URL}/api/catalog/reload", headers=headers, timeout=120).raise_for_status()

    # Then flush Redis so cache misses recompute against the new catalog.
    if databases:
        for db in databases:
            requests.post(
                f"{API_URL}/api/cache/invalidate/{db}", headers=headers, timeout=30
            ).raise_for_status()
    else:
        requests.post(
            f"{API_URL}/api/cache/invalidate-all", headers=headers, timeout=30
        ).raise_for_status()
```

The associated Pod spec snippet:

```yaml
spec:
  containers:
    - name: updater
      image: registry.example.com/ducklake-updater:1.0.0
      env:
        - name: DTA_API_URL
          value: 'http://api:80'
      envFrom:
        - secretRef:
            name: api-secrets # provides ADMIN_API_KEY
```

## When to use which

| Setup                                               | Recommended trigger                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Updater outside the cluster (CI, external host)     | `POST` to `https://api.mydomain.org/api/cache/invalidate-all` via Ingress                     |
| Updater inside the same cluster (CronJob, Job, Pod) | `POST` to `http://<release>:80/api/cache/invalidate-all` via Service ClusterIP DNS            |
| Local development on the same host as the API       | `curl` to `http://localhost:4000/api/cache/invalidate-all` with `x-admin-key: $ADMIN_API_KEY` |

## Stats

```bash
curl -fsS -H "x-admin-key: $ADMIN_API_KEY" \
  https://api.mydomain.org/api/cache/stats | jq
```

Returns nested `catalog → schema → type` cache key counts — useful for monitoring cache-warming after invalidation, or for confirming that an invalidation (catalog-wide or per-schema) reduced the key count as expected.

## Monitoring

Key log messages emitted by the API during a refresh (Winston, JSON format):

- `Reloading DuckDB instance (re-attaching catalogs)` — reload request received
- `DuckDB instance reloaded successfully` — new catalog attached and serving
- `Force-closing in-flight connections after drain timeout` — a request outlived the 30s drain window during reload (investigate slow queries)
- `Starting cache invalidation` — invalidation request received and authenticated
- `Invalidated <N> cache entries` — confirms keys deleted successfully
- `Cache invalidation failed` — requires investigation (Redis connectivity, timeout, etc.)

Combine with the `/api/cache/stats` endpoint for periodic snapshots:

```bash
# Scrape every 5 min into a time series
*/5 * * * *  curl -fsS -H "x-admin-key: $ADMIN_API_KEY" \
             https://api.mydomain.org/api/cache/stats \
             | jq -c '. + {ts: now}' >> /var/log/dta-cache-stats.jsonl
```

## Troubleshooting

**`401 Unauthorized`** — The `x-admin-key` header is missing or does not match the server's `ADMIN_API_KEY`. Verify the Secret value in the cluster (`kubectl --namespace dta get secret api-secrets -o jsonpath='{.data.ADMIN_API_KEY}' | base64 -d`) and that the calling Pod has it injected via `envFrom`.

**`503 Service Unavailable`** — `ADMIN_API_KEY` is unset on the server (fail-safe mode). Check the API ConfigMap / Secret wiring and that the env variable is present in the running Pod.

**Cache not invalidating despite `200 OK`** — Verify Redis connectivity from the API Pod (`kubectl --namespace dta exec deploy/api -- nc -zv $REDIS_HOST 6379`) and that the `REDIS_KEY_PREFIX` matches between the writers (resolvers) and the invalidator (`config/cache.yaml`).

**Invalidation reaches the API but Redis keys remain** — Likely a `REDIS_KEY_PREFIX` mismatch or a stale loader holding an in-memory entry. The in-memory DataLoader caches are per-request and clear on the next request; if you see stale data persisting beyond a few seconds, restart the API Pods (`kubectl --namespace dta rollout restart deploy/api`).

**Inspect cache contents directly** (dev/debug):

```bash
# from a Pod that can reach Redis
redis-cli -h $REDIS_HOST KEYS "graphql-api:*" | head
redis-cli -h $REDIS_HOST MONITOR     # live traffic
```

## Security notes

- The cache management endpoints **must not be exposed publicly without `ADMIN_API_KEY`**. The fail-safe (503 when unset) guarantees you cannot accidentally deploy them in open mode.
- Prefer the in-cluster path (Service ClusterIP) whenever the updater runs in the same cluster — the admin key never leaves the cluster network.
- Log all cache operations (already enabled — see `Starting cache invalidation` / `Invalidated <N> cache entries` log lines) for audit trails.
- Rate-limit the Ingress path if the API is reachable from untrusted networks. The endpoint is cheap but trivially DoS-able with valid credentials.
