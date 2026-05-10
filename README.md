# GraphQL DuckLake API

[![Build Image](https://github.com/qbolliet/dashboard-template-api/actions/workflows/build-image.yml/badge.svg)](https://github.com/qbolliet/dashboard-template-api/actions/workflows/build-image.yml)
[![Test](https://github.com/qbolliet/dashboard-template-api/actions/workflows/test.yml/badge.svg)](https://github.com/qbolliet/dashboard-template-api/actions/workflows/test.yml)
[![Deploy Documentation](https://github.com/qbolliet/dashboard-template-api/actions/workflows/docs.yml/badge.svg)](https://github.com/qbolliet/dashboard-template-api/actions/workflows/docs.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A production-ready **GraphQL API template** that connects to one or more [DuckLake](https://ducklake.select/) databases and exposes their content through a unified, read-only endpoint.

**[Full documentation →](https://qbolliet.github.io/dashboard-template-api/)**

---

## Key properties

| | |
|---|---|
| **Authentication** | None — fully public |
| **Operations** | Read-only (no mutations) |
| **Protection** | Rate limiting · complexity limits · depth limits |
| **Stack** | Apollo Server 5 · DuckDB · Express 5 · Redis · TypeScript |

The API is intentionally unauthenticated. It is designed to be deployed behind a reverse proxy with network-level access control. All catalogs are opened in read-only mode. Rate limiting, query complexity analysis, and input sanitization protect against abuse.

---

## Quick start

```bash
git clone https://github.com/qbolliet/dashboard-template-api
cd dashboard-template-api
cp .env.example .env          # set DuckLake paths and Redis URL
npm install
npm run dev                   # → http://localhost:4000/graphql
```

---

## npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Development server with auto-reload |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run start:prod` | Run compiled output |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run test:setup` | Load test fixtures |
| `npm test` | Run Jest test suite |
| `npm run test:coverage` | Tests with coverage report |
| `npm run db:update` | Handle database file update + cache invalidation |
| `npm run db:stats` | Display Redis cache statistics |

---

## Deployment

The API is published as a public OCI image and ships with a Helm chart for Kubernetes.

**Image** (GitHub Container Registry):

```bash
docker pull ghcr.io/qbolliet/dashboard-template-api:latest
```

**Helm** (chart published on every release tag):

```bash
helm repo add dta https://raw.githubusercontent.com/qbolliet/dashboard-template-api/gh-pages-charts/
helm install api dta/dashboard-template-api -f values.prod.yaml
```

The full deployment guide — Dockerfile internals, `values.yaml` reference, ingress + TLS, autoscaling, and how to invalidate the Redis cache from an external updater — lives at:

- [Deployment overview](https://qbolliet.github.io/dashboard-template-api/deployment/overview)
- [Docker](https://qbolliet.github.io/dashboard-template-api/deployment/docker)
- [Kubernetes & Helm](https://qbolliet.github.io/dashboard-template-api/deployment/kubernetes-helm)
- [Cache invalidation](https://qbolliet.github.io/dashboard-template-api/deployment/cache-invalidation)

---

## Repository structure

```
dashboard-template-api/
├── src/
│   ├── index.ts              # Entry point
│   ├── server.ts             # Apollo Server + Express setup
│   ├── db/                   # DuckDB connection and pool
│   ├── schema/
│   │   ├── typedefs/         # GraphQL type definitions
│   │   └── resolvers/        # Query resolvers
│   ├── loaders/              # DataLoader implementations
│   ├── security/             # Rate limiter, complexity, sanitization
│   ├── cache/                # Redis cache helpers
│   └── utils/                # Config loader, logger, utilities
├── config/
│   ├── api.yaml              # Port, CORS, pagination, timeouts
│   ├── database.yaml         # DuckLake catalog paths and pool
│   ├── security.yaml         # Rate limits, complexity, depth
│   ├── cache.yaml            # Redis connection and TTL
│   ├── logging.yaml          # Log levels and transports
│   └── security-patterns.yaml
├── tests/
│   ├── setup/                # Jest setup and DI container
│   ├── unit/                 # Unit tests mirroring src/
│   └── integration/          # End-to-end GraphQL tests
├── docs-site/                # Docusaurus documentation site
├── scripts/                  # Database update handler
├── docs/                     # Additional operational docs
├── helm/                     # Helm chart for Kubernetes deployment
│   └── dashboard-template-api/
└── Dockerfile                # Multi-stage production image
```

---

## Documentation

The full documentation is published at **https://qbolliet.github.io/dashboard-template-api/** and covers:

- [Getting started](https://qbolliet.github.io/dashboard-template-api/getting-started/installation) — installation, configuration, running tests
- [API guide](https://qbolliet.github.io/dashboard-template-api/api-guide/overview) — all queries with parameters and examples
- [Configuration reference](https://qbolliet.github.io/dashboard-template-api/configuration/overview) — every YAML key documented
- [Architecture](https://qbolliet.github.io/dashboard-template-api/architecture/overview) — security layers, caching, data loading
- [Schema explorer](https://qbolliet.github.io/dashboard-template-api/schema) — interactive GraphQL Voyager

To build the docs locally:

```bash
npm run build                                    # compile TypeScript first
node docs-site/scripts/generate-schema.mjs      # generate schema.json for Voyager
cd docs-site && npm install && npm run start
```

---

## License

MIT — see [LICENSE](LICENSE).
