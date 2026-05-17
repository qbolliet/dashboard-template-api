---
title: Installation
sidebar_position: 1
---

# Installation & Local Run

## Prerequisites

| Tool | Minimum version | Notes |
|------|----------------|-------|
| Node.js | 18 | Required for the ESM runtime |
| Redis | 7 | Or any Valkey-compatible instance |
| DuckLake files | — | One or more `.ducklake` catalog + data directory pairs |

## Steps

### 1. Clone the repository

```bash
git clone https://github.com/qbolliet/dashboard-template-api
cd dashboard-template-api
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set at minimum the paths to your DuckLake catalogs and your Redis connection:

```dotenv
# Paths to your DuckLake catalog files
DEFAULT_CATALOG_PATH=../my-db/outputs/default.ducklake
DEFAULT_DATA_PATH=../my-db/outputs/default_data/

# Optional additional catalogs
MACROECONOMICS_CATALOG_PATH=../my-db/outputs/macroeconomics.ducklake
MACROECONOMICS_DATA_PATH=../my-db/outputs/macroeconomics_data/

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
# REDIS_PASSWORD=your-password   # if Redis requires auth
```

See [Configuration](./configuration) for the complete list of environment variables and YAML overrides.

### 4. Start the development server

```bash
npm run dev
```

The server starts with auto-reload via `tsx watch`. The API is available at **http://localhost:4000/graphql**.

## Available endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/graphql` | POST | GraphQL endpoint |
| `/health` | GET | Liveness probe — returns `{ status: "ok" }` |
| `/ready` | GET | Readiness probe — checks DB connection + Redis |
| `/metrics` | GET | Performance metrics (p95/p99 latency, error rate, memory) |

## Production build

```bash
npm run build        # compile TypeScript → dist/
npm run start:prod   # run compiled output with Node
```

## npm scripts reference

| Script | Description |
|--------|-------------|
| `npm run dev` | Development server with auto-reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:prod` | Run compiled output |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |
| `npm run test:setup` | Load test fixtures into DuckLake files |
| `npm test` | Run all Jest tests |
| `npm run test:coverage` | Run tests with coverage report |
