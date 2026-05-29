---
id: intro
title: Introduction
sidebar_position: 1
slug: /
---

# GraphQL DuckLake API

A production-ready **GraphQL API template** built on [Apollo Server](https://www.apollographql.com/docs/apollo-server/) and [DuckDB](https://duckdb.org/), designed to expose analytical dashboard data with zero authentication overhead.

## What is this?

This template connects to one or more **DuckLake** databases (DuckDB catalog format) and exposes their content through a unified, read-only GraphQL API. It is intended as a starting point for teams that need to:

- Power analytics dashboards with fast, server-side aggregations
- Expose data from several thematic DuckLake catalogs (e.g. macroeconomics, public finance) through a single endpoint
- Share data with multiple frontend clients without per-user authentication

## Key properties

| Property           | Value                                                |
| ------------------ | ---------------------------------------------------- |
| **Authentication** | None — the API is fully public                       |
| **Operations**     | Read-only (no mutations or subscriptions)            |
| **Protection**     | Rate limiting, query complexity limits, depth limits |
| **Databases**      | Multiple DuckLake catalogs, independently routed     |

The API is intentionally unauthenticated. Access is protected at the network level (reverse proxy, firewall) and at the application level through configurable rate limiting. All parameters — window size, maximum requests, burst budget — are set in `config/security.yaml`.

## Features at a glance

- **Multi-catalog / multi-schema routing** — query different catalogs (and schemas within them) via the `catalog` / `schema` arguments or the `x-catalog-id` / `x-schema-id` HTTP headers
- **Flexible querying** — filter, sort, and paginate facts and dimensions with a structured filter API
- **Aggregations** — SUM, AVG, MAX, MIN, COUNT, MEDIAN, MODE with optional D3-ready metadata (extents, statistics)
- **Cross-database comparisons** — compare facts across two catalogs with delta and percentage values
- **Select options** — dynamic dropdown lists for any categorical field, with optional full-text search
- **Redis cache** — automatic result caching with per-type TTL and on-demand invalidation
- **Security layers** — query depth and complexity limits, XSS/SQL input sanitization, per-IP rate limiting
- **Observability** — structured JSON logging (Winston), per-request metrics, `/health`, `/ready`, `/metrics` endpoints

## Quick start

```bash
git clone https://github.com/qbolliet/dashboard-template-api
cd dashboard-template-api
cp .env.example .env        # configure DuckLake paths and Redis URL
npm install
npm run dev
```

Open [http://localhost:4000/graphql](http://localhost:4000/graphql) for Apollo Sandbox.

See [Installation](./getting-started/installation) for the full setup guide.
