---
title: Data refresh
sidebar_position: 4
---

# Data refresh

When DuckLake catalogs are refreshed (typically by a nightly external process), **every API
replica picks up the new data on its own**, within one probe interval. The updater has
nothing to call: it writes the catalog and the Parquet files, and stops there.

```
1. Updater writes the new DuckLake catalog + Parquet (to disk, S3 or Postgres)
   — dataset_metadata.updated_at is stamped in the same transaction
2. Nothing else. Within CATALOG_FRESHNESS_INTERVAL_MS (60 s by default)
   every pod detects the new marker, reloads itself and switches its
   Redis keys to the new data version.
```

Adding or dropping a schema follows the same path: the probe also lists the schemas of
each catalog, so a new schema appears in `getCatalogs` (and a dropped one disappears) on
every pod within one interval, without any call. See
[Adding or removing a schema](#adding-or-removing-a-schema).

`POST /api/catalog/reload` still exists as an optional accelerator, and the cache
invalidation routes remain for a manual flush, but neither is part of the refresh any more.

## How a replica sees an update

Each pod attaches its DuckLake catalogs to one in-memory DuckDB instance and keeps serving
that state; Redis is shared by all pods. Two mechanisms keep them fresh without any call:

1. **A periodic probe per pod** ([`src/db/catalog-freshness.ts`](https://github.com/qbolliet/dashboard-template-api/blob/main/src/db/catalog-freshness.ts)).
   Every `CATALOG_FRESHNESS_INTERVAL_MS`, the pod creates a throw-away DuckDB instance,
   attaches each catalog `READ_ONLY` afresh, lists its schemas
   (`information_schema.schemata`), reads `dataset_metadata.updated_at` of every served
   schema still listed, and closes the instance. The schema list is reconciled with the
   configuration exactly as a reload does it (`reconcileSchemas`: `main` fallback, `SCHEMAS`
   allow-list). When a marker differs from the version the pod serves, or when the
   reconciled list differs from the served one (a schema added or removed, order ignored),
   it rebuilds its shared instance (`reloadCatalogs`: new instance built first, atomic
   swap, old instance drained), then re-reads the schemas and markers **on the new live
   instance**. Several catalogs changed at once cost a single rebuild.
2. **Versioned cache keys.** The marker the live instance serves is part of every Redis key:
   `<type>:<catalog>:<schema>@<version>:<variant><hash>`. As soon as a pod serves a new
   version, it reads and writes new keys; entries computed on older data are no longer
   reachable, without any `SCAN`, and expire by TTL. A pod that has not probed yet keeps
   using the old keys, consistently with the old data it still serves — pods never mix
   versions under one key. See [Caching](../architecture/caching#versioned-namespaces).

### The version marker

The marker is `dataset_metadata.updated_at`, per (catalog, schema), encoded as
`epoch_us(updated_at)` (digits only, so it cannot break the `:`-separated key layout; `none`
when the row or the table is missing). It was preferred to the DuckLake snapshot id:

- **Per schema.** The snapshot id is per catalog: a write to one schema would move the keys
  of every schema of the catalog.
- **Atomic with the write.** dt-ducklake-manager stamps `updated_at` inside the transaction
  of every write (`_touch_dataset_metadata`), so the marker and the data land in the same
  snapshot.
- **Blind to maintenance.** Compaction (`ducklake_merge_adjacent_files`) or
  `ducklake_flush_inlined_data` commit snapshots without changing the data; with the
  snapshot id, each would reload every pod and cold-start the cache.
- **Free.** It is read by the query that already reads `schema_version` for the version guard.

The snapshot id is readable too (`ducklake_current_snapshot('<alias>')` exists in the
installed DuckLake), but any writer other than dt-ducklake-manager **must stamp
`updated_at` on every write** (specification §2.3), or its writes will not be detected.

### Why a fresh ATTACH for the probe

Checked against DuckDB 1.5.2 / DuckLake `415a9ebd`:

| Catalog backend                   | Writer while a reader is attached                          | Existing ATTACH sees the write | Fresh ATTACH sees it |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------ | -------------------- |
| `.ducklake` file (DuckDB)         | Blocked by the reader's file lock (Windows: "file in use") | No                             | Yes                  |
| SQLite metadata                   | Allowed                                                    | Yes                            | Yes                  |
| Postgres metadata                 | Allowed                                                    | Not verified locally¹          | Yes                  |
| `.ducklake` file on S3 (replaced) | Allowed (new object)                                       | No (attached at startup)       | Yes                  |

¹ Expected yes, as for SQLite: DuckLake reads an external metadata database per
transaction. The design does not depend on it — the probe always uses a fresh instance, and
the rebuild always serves the latest state, whatever the backend.

### Freshness guarantees

- **Delay**: at most one interval plus the probe and rebuild time (well under a second for
  a local catalog, longer over S3), plus the drain of in-flight requests (capped at 30 s).
- **No stale data under a new key**: the new version is only published once the retired
  instance is drained and closed, so no connection still reading the old state can write
  under a new-version key.
- **Read error ⇒ no switch**: if the probe cannot read a catalog (S3 or Postgres
  unreachable, file locked by the writer), the pod keeps serving what it has, logs a warn,
  and retries at the next interval. The same holds for a schema list that cannot be read
  (the markers are still read and compared). A failed rebuild is retried the same way.
- **Stable fallbacks**: a catalog where nothing is discovered (served as `["main"]`) or
  whose `SCHEMAS` allow-list is narrower than the catalog never reloads for that reason:
  the probe compares the reconciled list, not the raw discovery.
- **Probe cost**: listing the schemas only reads the DuckLake catalog loaded by the
  `ATTACH`. On the three test catalogs (11 schemas), a probe went from 432 ms to 447 ms
  (median of 60 runs), most of it being the instance creation and the `ATTACH`.
- **HTTP caching**: `/graphql` responses carry `Cache-Control: public, max-age=300`. A CDN or
  a browser may serve a response up to that age after the switch.

## Configuration

```yaml
# config/database.yaml
CATALOG_FRESHNESS:
  ENABLED: ${CATALOG_FRESHNESS_ENABLED:-true}
  INTERVAL_MS: ${CATALOG_FRESHNESS_INTERVAL_MS:-60000}
```

In Kubernetes both variables sit in the chart's `config:` block (see
[Kubernetes & Helm](./kubernetes-helm)). With `ENABLED: false` nothing is detected
automatically and the updater must call `POST /api/catalog/reload` on **every** pod (the
Service routes a call to one pod only) — keep it enabled with more than one replica.

## Endpoints

All admin endpoints require the `x-admin-key` header set to `ADMIN_API_KEY`. Without a
valid key every endpoint returns `401`. If `ADMIN_API_KEY` is unset on the server, every
endpoint returns `503` (fail-safe).

| Method | Path                                     | Purpose                                                                                                        |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/catalog/reload`                    | Immediate probe with a forced rebuild **on the pod that receives it**; returns the data versions it now serves |
| `POST` | `/api/catalog/reload/:catalog`           | Reattach a **single** catalog (scoped `DETACH` + `ATTACH`) on the receiving pod                                |
| `POST` | `/api/cache/invalidate-all`              | Manual flush of every catalog namespace (all versions)                                                         |
| `POST` | `/api/cache/invalidate/:catalog`         | Manual flush of one catalog, every schema                                                                      |
| `POST` | `/api/cache/invalidate/:catalog/:schema` | Manual flush of one schema of one catalog                                                                      |
| `GET`  | `/api/cache/stats`                       | Nested `catalog → schema → type` cache key counts (all versions)                                               |

`POST /api/catalog/reload` answers once the pod serves the new catalog and its cache keys
carry the new version:

```json
{
  "success": true,
  "timestamp": "2026-09-28T02:31:04.512Z",
  "changed": ["macroeconomics"],
  "versions": {
    "macroeconomics": {
      "main": { "version": "1790563200000000", "updatedAt": "2026-09-28T02:30:00.000000Z" }
    }
  }
}
```

It is useful to make one pod fresh immediately (a smoke test right after the update, for
instance); the other pods follow at their next probe. Calling
`/api/cache/invalidate-all` after a refresh is no longer needed: it only forces the new
version's keys to be recomputed.

### Reloading a single catalog

`POST /api/catalog/reload/:catalog` reattaches one catalog on the **live** instance of the
receiving pod — a scoped `DETACH "<catalog>"` followed by its `ATTACH`. A query already
running against that catalog during the brief window may error; if the `ATTACH` fails the
catalog stays detached until the next successful probe. The automatic path uses the full,
zero-interruption rebuild instead.

## What the updater does

```python
def nightly_update() -> None:
    refresh_ducklake_catalogs()   # dt-ducklake-manager: data + updated_at, one transaction
    # Done: every pod switches within CATALOG_FRESHNESS_INTERVAL_MS.
```

Optionally, to fail the job when no pod picks the update up, poll `/metrics` (see below)
until `servedVersion` equals the version just written, or call `/api/catalog/reload` once
and check its `versions`:

```python
import os
import requests

API_URL = os.environ.get("DTA_API_URL", "http://api:80")   # in-cluster Service DNS
HEADERS = {"x-admin-key": os.environ["ADMIN_API_KEY"]}

r = requests.post(f"{API_URL}/api/catalog/reload", headers=HEADERS, timeout=120)
r.raise_for_status()
print(r.json()["versions"])
```

Inside the cluster, prefer the Service DNS (`http://<release>:80`, `ADMIN_API_KEY` injected
with `envFrom: secretRef: api-secrets`): no Ingress traversal, the key never leaves the
cluster network.

## Adding or removing a schema

The updater creates or drops the schema in the catalog; no API call and no configuration
change is needed when `SCHEMAS` is not set (the default).

**Adding a schema.** Create it with its three tables (`fact_table`, `metadata`,
`dataset_metadata` with its single row), ideally in one transaction. Within one interval,
every pod lists it, reloads and serves it; `getCatalogs` exposes it once its
`dataset_metadata.schema_version` is supported. If the schema becomes visible before its
`dataset_metadata` is written (tables created in several transactions), the pods serve it
without a data version: it is refused by the version guard (`SCHEMA_VERSION_UNSUPPORTED`,
a client error, never a 500) and left out of `getCatalogs`. The probe that follows the
write of `dataset_metadata` sees the new marker, reloads, and the schema is exposed.

**Removing a schema.** Drop its tables and the schema (one transaction). Within one
interval every pod reloads without it: it disappears from `getCatalogs`, and queries on it
get a `BAD_USER_INPUT` error listing the available schemas. The probe no longer reads its marker, so no
warning repeats afterwards. Its Redis entries are never read again and expire by TTL.

**With a `SCHEMAS` allow-list**, only the listed schemas are served: adding a schema outside
the list changes nothing (no reload); removing a listed one reloads the pods without it.

Check the result on any pod in `/metrics` (`catalogFreshness.catalogs.<name>.discoveredSchemas`
lists what the last probe saw) or with `getCatalogs`.

## Monitoring

`GET /metrics` reports, per pod, the freshness state of every schema:

```json
"catalogFreshness": {
  "enabled": true,
  "intervalMs": 60000,
  "lastReloadAt": "2026-09-28T02:31:04.512Z",
  "lastReloadError": null,
  "skippedTicks": 0,
  "catalogs": {
    "macroeconomics": {
      "lastProbeAt": "2026-09-28T02:32:00.004Z",
      "lastProbeOk": true,
      "lastError": null,
      "lastChangeAt": "2026-09-28T02:31:04.201Z",
      "discoveredSchemas": ["main", "trade"],
      "schemas": {
        "main": {
          "servedVersion": "1790563200000000",
          "servedUpdatedAt": "2026-09-28T02:30:00.000000Z",
          "probedVersion": "1790563200000000",
          "probedUpdatedAt": "2026-09-28T02:30:00.000000Z",
          "lastProbeAt": "2026-09-28T02:32:00.004Z",
          "lastError": null
        }
      }
    }
  }
}
```

`/metrics` is not yet behind the admin key (planned); the markers are timestamps, not data.

Key log messages (Winston, JSON):

- `Catalog update detected, reloading catalogs` (info) — a probe saw a new marker or a
  new schema list
- `Catalog schema list changed` (info) — with the `added` and `removed` schemas
- `Catalog freshness probe failed; keeping the served version` (warn) — catalog unreadable
- `Data marker unreadable; keeping the served version` (warn) — one schema unreadable
- `Schema list unreadable; keeping the served schemas` (warn) — the list of a catalog
  could not be read (markers still compared)
- `Catalog reload after update failed; retrying at next probe` (warn)
- `Reloaded catalog serves another version than the one probed` (warn) — see below
- `Reloaded catalog serves another schema list than the one probed` (warn) — same cause
- `Force-closing in-flight connections after drain timeout` (warn) — a request outlived
  the 30 s drain window during a rebuild

## Troubleshooting

**A pod never switches** — Check `catalogFreshness` in its `/metrics`: `lastProbeOk: false`
with `lastError` names the cause (credentials, network, file lock). If `probedVersion`
never changes, the writer did not stamp `dataset_metadata.updated_at`.

**A new schema never appears in `getCatalogs`** — If `discoveredSchemas` does not list it,
the probe does not see it (wrong catalog, write not committed). If it is listed, check the
logs of the last reload: `Unsupported schema version for <catalog>.<schema>` means its
`dataset_metadata` is missing, empty or in an unsupported version; a
`SCHEMAS` allow-list that does not name it keeps it out on purpose.

**`Reloaded catalog serves another version than the one probed`** — The rebuilt instance
reads another state than the probe: a newer write landed in between (harmless, the next
probe settles it), or a cache in front of the storage served the old object.

**Stale answers right after the switch** — The HTTP `Cache-Control: public, max-age` of
`/graphql` lets a CDN or browser keep a response for up to that age.

**`401` / `503` on the admin routes** — Missing or wrong `x-admin-key`, or `ADMIN_API_KEY`
unset on the server (fail-safe).

**Inspect cache contents** (dev/debug):

```bash
redis-cli -h $REDIS_HOST --scan --pattern "graphql-api:facts:macroeconomics:main@*" | head
```

## Security notes

- The admin endpoints **must not be exposed publicly without `ADMIN_API_KEY`**; the fail-safe
  (503 when unset) prevents deploying them in open mode.
- Since the refresh no longer calls them, the updater does not need the admin key at all.
- Admin routes are rate-limited before the key check.
