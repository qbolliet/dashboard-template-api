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

Every request counts toward the limits, whatever its outcome.

Limits apply per client IP. If you deploy behind a reverse proxy, configure `TRUSTED_PROXIES` (IPs or CIDR blocks, e.g. `'["10.0.0.0/8"]'`) so that the real client IP is read from the `x-forwarded-for` header.

## Query protection

Beyond rate limiting, every query is validated against these checks before execution:

| Check                  | Default (dev / prod) | Config key                               |
| ---------------------- | -------------------- | ---------------------------------------- |
| Max depth              | 15 / 7               | `SECURITY.MAX_QUERY_DEPTH`               |
| Max root fields        | 20                   | `SECURITY.COMPLEXITY.MAX_ROOT_FIELDS`    |
| Max complexity         | 200                  | `SECURITY.COMPLEXITY.MAX_ALLOWED`        |
| Max `limit` / `offset` | 1000 / 10000         | `API.PAGINATION.MAX_LIMIT`, `MAX_OFFSET` |

Every root field pays a base score (1 for `getCatalogs` up to 15 for `compareFacts`), plus 0.1 per row requested through `limit` (an omitted `limit` counts at its default), +2 for a filter tree and +1 for a sort; nested objects cost 1 × 1.5^depth, and `Metadata.stats` costs 5 per column of its list. `getCatalogSchema { stats }` therefore stays within budget up to 39 columns: to read the bounds of a few columns, prefer `getFieldStats` on the columns you display. An operation above a ceiling gets `QUERY_COMPLEXITY_EXCEEDED` (HTTP 400) with its score in `extensions`.

## Multi-catalog routing

The API can serve multiple DuckLake catalogs simultaneously. The active catalog is selected per query via the
`catalog` GraphQL argument (available on all queries); `schema` selects a schema within the catalog. Both are
plain arguments — the API never reads routing information from request headers.

When `catalog` is omitted, the `DEFAULT_CATALOG` is used (configurable in `config/database.yaml`); when `schema`
is omitted, the catalog's own default schema is used.

Cross-catalog queries (`compareFacts`, `compareAggregatedFacts`) accept two explicit catalog IDs (and optional per-side schemas) and execute against both in a single request. Each side is first aggregated by its keys (one row per key, whatever the number of fact rows), then the two sides are joined. The fact table stores labels directly, so they join on the columns themselves (cast to `VARCHAR` to absorb a type difference between catalogs): a match is on the label.

## HTTP cache headers

Responses from `/graphql` carry `Cache-Control: no-store`: they are cached server-side in Redis only, never by a CDN or a browser.
