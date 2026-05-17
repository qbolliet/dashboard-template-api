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

| File | Role |
|------|------|
| `src/index.ts` | Process entry — loads `.env`, calls `startServer()`, handles uncaught errors |
| `src/server.ts` | Wires Express middleware, Apollo Server, health/metrics routes, graceful shutdown |

## Key modules

### Database layer (`src/db/`)

| File | Role |
|------|------|
| `connection.ts` | Opens and closes a DuckDB connection to a catalog |
| `pool.ts` | Connection pool — limits concurrent connections per catalog |
| `database-manager.ts` | High-level API: acquires a pooled connection, runs a query, releases |
| `index.ts` | Re-exports the shared DatabaseManager singleton |

### GraphQL schema (`src/schema/`)

| File | Role |
|------|------|
| `typedefs/index.ts` | Merges all type definition modules |
| `typedefs/*.ts` | One file per domain: `fact`, `dimension`, `metadata`, `select`, `catalog`, `cross-database` |
| `resolvers/index.ts` | Merges all resolver modules |
| `resolvers/*.ts` | One file per domain, mirrors typedefs |
| `index.ts` | Builds the executable schema via `makeExecutableSchema` |

### Data loaders (`src/loaders/`)

DataLoaders batch and deduplicate DB calls within a single GraphQL request. Each loader has a per-type TTL in the DataLoader cache (in-memory, request-scoped) that complements the Redis cache.

| Loader | Batches |
|--------|---------|
| `fact.ts` | Fact table queries |
| `dimension.ts` | Dimension table lookups |
| `metadata.ts` | Field metadata |
| `select-options.ts` | Select option lists |
| `aggregated-facts.ts` | Aggregation queries |
| `catalog.ts` | Catalog/database listing |
| `cross-database.ts` | Cross-catalog operations |

### Security (`src/security/`)

See [Security architecture](./security).

### Cache (`src/cache/`)

See [Caching](./caching).

### Utils (`src/utils/`)

| File | Role |
|------|------|
| `config-loader.ts` | Loads and deep-merges all YAML config files; handles env var substitution |
| `logger.ts` | Winston logger factory (console + rotating file transports) |
| `cache.ts` | Redis cache helpers (get, set, invalidate) |
| `timeout.ts` | Complexity-based query timeout computation |
| `dimension-enrichment.ts` | Joins dimension labels onto fact rows |
| `utils.ts` | Shared utility functions |

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
1. Stop accepting new HTTP requests
2. Wait for in-flight requests to complete
3. Close all DuckDB connections in the pool
4. Disconnect from Redis
5. Flush and close log transports
