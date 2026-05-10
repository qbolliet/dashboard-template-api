---
title: Cache invalidation
sidebar_position: 4
---

# Cache invalidation

When DuckLake catalogs are refreshed (typically by a nightly external process), the API's Redis cache must be invalidated so that subsequent queries see the new data.

## Architecture

```
┌──────────────────────┐          ┌──────────────────────────┐
│ External updater     │          │  API (Kubernetes / Docker)│
│ (Python script,      │          │                          │
│  cron, CI job…)      │          │  POST /api/cache/        │
│                      │ ───────▶ │       invalidate-all     │
│  1. Refresh DuckLake │   x-admin-key                       │
│  2. Call API         │          │                          │
└──────────────────────┘          │  ┌────────────────────┐  │
                                  │  │ Redis SCAN + DEL   │  │
                                  │  │ per database       │  │
                                  │  │ namespace          │  │
                                  │  └────────────────────┘  │
                                  └──────────────────────────┘
```

The API is responsible for cache state. The external updater is responsible only for refreshing DuckLake files and triggering invalidation via HTTP — no shared filesystem or shared library is needed.

## Endpoints

All admin endpoints require the `x-admin-key` header set to `ADMIN_API_KEY`. Without a valid key, every endpoint returns `401`. If `ADMIN_API_KEY` is unset on the server, every endpoint returns `503` (fail-safe).

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/cache/invalidate-all` | Invalidate every database namespace |
| `POST` | `/api/cache/invalidate/:database` | Invalidate one database (e.g. `default`, `macroeconomics`) |
| `GET`  | `/api/cache/stats` | Per-database / per-type cache key counts |

Invalidation is a non-blocking SCAN + DEL pass on the keys matching the per-database patterns:

```
metadata:<db>:*
dimension:<db>:*
dimension-value:<db>:*
facts:<db>:*
aggregated-facts:<db>:*
select-options:<db>:*
```

The implementation lives in [`src/cache/cache-invalidation.ts`](https://github.com/qbolliet/dashboard-template-api/blob/main/src/cache/cache-invalidation.ts).

## Calling from a Python updater

```python
import os
import requests

API_URL = os.environ["DTA_API_URL"]                 # e.g. https://api.mydomain.org
ADMIN_KEY = os.environ["DTA_ADMIN_KEY"]

# After refreshing DuckLake catalogs:
r = requests.post(
    f"{API_URL}/api/cache/invalidate-all",
    headers={"x-admin-key": ADMIN_KEY},
    timeout=30,
)
r.raise_for_status()
print(r.json())   # {"success": true, "invalidated": 1234, ...}
```

For per-database invalidation:

```python
for db in ("default", "macroeconomics"):
    requests.post(
        f"{API_URL}/api/cache/invalidate/{db}",
        headers={"x-admin-key": ADMIN_KEY},
        timeout=30,
    ).raise_for_status()
```

## Calling from `bash` / cron

```bash
curl -fsS -X POST \
  -H "x-admin-key: $ADMIN_API_KEY" \
  https://api.mydomain.org/api/cache/invalidate-all
```

A typical crontab entry on the host running the updater:

```cron
30 2 * * *  /usr/local/bin/refresh-ducklake.sh && \
            curl -fsS -X POST -H "x-admin-key: $ADMIN_API_KEY" \
              https://api.mydomain.org/api/cache/invalidate-all \
            >> /var/log/dta-cache-invalidate.log 2>&1
```

## In-process alternative (development)

When you run the API locally and your refresh process is on the same host, you can invalidate without HTTP via the bundled script:

```bash
npm run db:update                              # all databases
node scripts/handle-database-update.js \
     --databases default,macroeconomics        # specific ones
node scripts/handle-database-update.js --dry-run
```

It uses the same `CacheInvalidationManager` as the HTTP endpoint. **Prefer the HTTP endpoint** for production / cluster deployments — the script is intended for dev or single-host setups.

## When to use which

| Setup | Recommended trigger |
|-------|--------------------|
| Updater outside cluster, API in K8s | `POST /api/cache/invalidate-all` via ingress |
| Updater inside same K8s cluster | `POST` via `Service` ClusterIP DNS |
| Updater on same host as API (dev) | `npm run db:update` |
| Manual / one-off | `npm run db:invalidate` (curl wrapper, see `package.json`) |

## Stats

```bash
curl -fsS -H "x-admin-key: $ADMIN_API_KEY" \
  https://api.mydomain.org/api/cache/stats | jq
```

Returns per-database, per-type cache key counts — useful for monitoring cache-warming after invalidation.
