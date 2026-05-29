---
title: Overview
sidebar_position: 1
---

# API Overview

## Public and read-only

The GraphQL DuckLake API is **fully public**: no API key, no JWT, no OAuth flow is required. Any client that can reach the server can issue queries.

Access control is handled at two levels:

1. **Network level** — deploy behind a reverse proxy (nginx, Caddy, AWS ALB, …) and restrict access to your target audience via firewall rules, IP allowlists, or VPC policies
2. **Application level** — the built-in rate limiter blocks abusive clients before they can overload the database

The API exposes **only queries** (no mutations, no subscriptions). All DuckLake catalogs are opened in read-only mode (`READ_ONLY: true` in `config/database.yaml`).

## Rate limiting

Every client IP is subject to two sliding-window limits configured in `config/security.yaml`:

| Limit          | Default          | Config key                                                   |
| -------------- | ---------------- | ------------------------------------------------------------ |
| Sustained rate | 100 req / 15 min | `SECURITY.RATE_LIMIT.MAX_REQUESTS` / `WINDOW_MS`             |
| Burst rate     | 20 req / 1 min   | `SECURITY.RATE_LIMIT.MAX_BURST_REQUESTS` / `BURST_WINDOW_MS` |

When a limit is hit the server returns HTTP `429 Too Many Requests`.

Failed requests are not counted by default (`SKIP_FAILED_REQUESTS: false` means failed requests ARE counted — set to `true` to only count successful ones).

If you deploy behind a reverse proxy, configure `TRUSTED_PROXIES` so that the real client IP is read from the `x-forwarded-for` header.

## Query protection

Beyond rate limiting, every query is validated against three independent checks before execution:

| Check              | Default (dev / prod) | Config key                        |
| ------------------ | -------------------- | --------------------------------- |
| Max depth          | 15 / 7               | `SECURITY.MAX_QUERY_DEPTH`        |
| Max complexity     | 100                  | `SECURITY.COMPLEXITY.MAX_ALLOWED` |
| Input sanitization | enabled              | `SECURITY.SANITIZATION`           |

Complexity is computed per query using configurable cost weights: scalar fields cost 0, object fields cost 1, lists multiply child cost by 10, and depth adds a 1.5× factor. Expensive operations (`getAggregatedFacts`, `getFactTable`) carry additional base scores.

## Multi-catalog routing

The API can serve multiple DuckLake catalogs simultaneously. The active catalog is selected per request via:

- The `catalog` GraphQL argument (available on all queries); `schema` selects a schema within the catalog
- The `x-catalog-id` HTTP header (applies to the whole request); `x-schema-id` for the schema

When neither is provided, the `DEFAULT_CATALOG` is used (configurable in `config/database.yaml`).

Cross-catalog queries (`compareFacts`, `compareAggregatedFacts`) accept two explicit catalog IDs (and optional per-side schemas) and execute against both in a single request. They resolve categorical IDs to dim\_\* labels before joining, so a match is on the modality, never the raw ID.

## HTTP cache headers

Responses from `/graphql` include `Cache-Control` headers optimised for CDN and browser caching:

```
Cache-Control: public, max-age=<TTL>
Vary: accept-encoding, accept
```

TTL values per data type are set in `config/cache.yaml`.
