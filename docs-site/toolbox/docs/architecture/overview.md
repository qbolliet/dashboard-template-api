---
title: Overview
sidebar_position: 1
---

# Architecture Overview

## High-level diagram

```
Client
  │
  ▼
Express (HTTP middleware)
  ├─ CORS, compression, request size limits
  ├─ HTTP cache headers
  └─ Rate limiter (Redis-backed, per IP)
        │
        ▼
   Apollo Server (GraphQL)
  ├─ Depth limit validation rule
  ├─ Complexity analysis
  ├─ Input sanitization
  └─ Field-level security middleware
        │
        ▼
   Resolvers
  ├─ DataLoaders (batching + in-request cache)
  └─ Redis cache (cross-request, per-type TTL)
        │
        ▼
   DuckDB / DuckLake
  (read-only, connection pool)
```

## Entry points

| File            | Role                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| `src/index.ts`  | Process entry — loads `.env`, calls `startServer()`, handles uncaught errors      |
| `src/server.ts` | Wires Express middleware, Apollo Server, health/metrics routes, graceful shutdown |

## Key modules

### Database layer (`src/db/`)

| File                       | Role                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `connection.ts`            | Opens and closes a DuckDB connection to a catalog                    |
| `pool.ts`                  | Connection pool — limits concurrent connections per catalog          |
| `database-manager.ts`      | High-level API: acquires a pooled connection, runs a query, releases |
| `catalog-freshness.ts`     | Per-pod probe detecting catalog updates, then reloading the pod      |
| `schema-reconciliation.ts` | Pure reconciliation of discovered schemas with the configuration     |
| `catalog-routes.ts`        | Admin reload routes (`/api/catalog/reload[/:catalog]`)               |
| `index.ts`                 | Re-exports the shared DatabaseManager singleton                      |

#### Catalog freshness

Each pod attaches its DuckLake catalogs once and serves that state. Started by
`startServer()` after the schemas are reconciled, `catalogFreshnessMonitor` reads
`dataset_metadata.updated_at` of every schema every `CATALOG_FRESHNESS.INTERVAL_MS` on a
throw-away DuckDB instance (a fresh `ATTACH` sees the latest commit), and lists the schemas
of each catalog. The list goes through the same pure reconciliation as a reload
(`reconcileSchemaList`: `main` fallback, `SCHEMAS` allow-list). When a marker differs from
the version the pod serves, or a schema was added or removed, the pod rebuilds its
instance (build, swap, drain), then re-reads the schemas and markers on the live instance;
the schema list, the version-guard verdicts and the data versions switch together. That
served version is part of every Redis key, so no stale entry can be read after the switch,
on any replica, without any call from the updater. See [Data refresh](../deployment/data-refresh).

### GraphQL schema (`src/schema/`)

| File                 | Role                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| `typedefs/index.ts`  | Merges all type definition modules                                             |
| `typedefs/*.ts`      | One file per domain: `fact`, `metadata`, `select`, `catalog`, `cross-database` |
| `resolvers/index.ts` | Merges all resolver modules                                                    |
| `resolvers/*.ts`     | One file per domain, mirrors typedefs                                          |
| `index.ts`           | Builds the executable schema via `makeExecutableSchema`                        |

### Data loaders (`src/loaders/`)

DataLoaders batch and deduplicate DB calls within a single GraphQL request. Each loader has a per-type TTL in the DataLoader cache (in-memory, request-scoped) that complements the Redis cache.

| Loader                | Batches                  |
| --------------------- | ------------------------ |
| `fact.ts`             | Fact table queries       |
| `metadata.ts`         | Field metadata           |
| `select-options.ts`   | Select option lists      |
| `aggregated-facts.ts` | Aggregation queries      |
| `catalog.ts`          | Catalog/database listing |
| `cross-database.ts`   | Cross-catalog operations |

### Security (`src/security/`)

See [Security architecture](./security).

### Cache (`src/cache/`)

See [Caching](./caching).

### Utils (`src/utils/`)

| File                | Role                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `config-loader.ts`  | Loads and deep-merges all YAML config files; handles env var substitution |
| `logger.ts`         | Winston logger factory (console + rotating file transports)               |
| `cache.ts`          | Redis cache helpers (get, set, invalidate)                                |
| `timeout.ts`        | Complexity-based query timeout computation                                |
| `fact-partition.ts` | Splits a fact row into its keys and its measures                          |
| `utils.ts`          | Shared utility functions                                                  |

## Request lifecycle

1. **HTTP** — Express applies CORS, compression, size limits, and HTTP cache headers
2. **Rate limit** — sliding-window check per client IP (Redis-backed)
3. **Apollo** — parses and validates the GraphQL query
4. **Depth check** — rejects queries deeper than the configured limit
5. **Complexity check** — computes a weighted complexity score; rejects if over threshold
6. **Input sanitization** — strips XSS/SQL patterns from all string arguments
7. **Execution** — resolvers fire; DataLoaders batch concurrent DB calls
8. **Redis cache** — resolver results are cached before returning to the client
9. **Response** — Apollo serialises the result; Express adds cache headers

## Graceful shutdown

`SIGTERM` and `SIGINT` trigger a coordinated shutdown:

1. Stop the catalog freshness probe. From then on `/ready` answers `503` and every other request is refused with a `503` (`Connection: close`, `Retry-After`); `/health` keeps answering so the liveness probe does not restart the pod
2. Stop accepting connections and **drain**: in-flight requests, REST exports included, run to completion (`ApolloServerPluginDrainHttpServer`). Connections still open after 80 % of the budget are cut
3. Close all DuckDB connections in the pool, then the rate limiters, then Redis — nothing holds a connection any more at that point
4. Exit `0` (or `1` if a step failed)

The whole sequence is bounded by `API.SHUTDOWN.TIMEOUT_MS` (`SHUTDOWN_TIMEOUT_MS`, 25 s by default): a watchdog exits with `1` at that deadline whatever is still blocked. It must stay **below** the pod's `terminationGracePeriodSeconds`, otherwise the kubelet's `SIGKILL` cuts the drain; the Helm chart refuses to render when it is not. An export that outlasts the budget is cut (truncated file, no Arrow end-of-stream), so size both to the longest export you accept to finish during a rolling update. Apollo's own termination-signal handling is disabled (`stopOnTerminationSignals: false`): it would re-raise the signal on the process in the middle of the drain.
