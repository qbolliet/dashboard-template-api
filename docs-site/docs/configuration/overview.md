---
title: Overview
sidebar_position: 1
---

# Configuration Reference

All configuration files live in `config/` and are loaded and deep-merged by `src/utils/config-loader.ts` at startup. Every value supports `${ENV_VAR:-default}` substitution.

## Files

| File | Covers |
|------|--------|
| [`config/api.yaml`](./api) | Port, CORS, pagination limits, timeouts, data loaders |
| [`config/database.yaml`](./database) | DuckLake catalog paths, connection pool, S3 |
| [`config/security.yaml`](./security) | Rate limiting, complexity, depth limits, sanitization |
| [`config/cache.yaml`](./cache) | Redis connection, TTL values, cache invalidation |
| [`config/logging.yaml`](./logging) | Log levels, transports, sampling, sanitized fields |

`config/security-patterns.yaml` holds the regex patterns used by `src/security/pattern-validator.ts` for input validation and is not documented here as it rarely needs modification.

## Environment variables quick reference

The most commonly used variables:

```dotenv
# Server
PORT=4000
NODE_ENV=production

# Catalogs
DEFAULT_CATALOG_PATH=./data/default.ducklake
DEFAULT_DATA_PATH=./data/default_data/
MACROECONOMICS_CATALOG_PATH=./data/macroeconomics.ducklake
MACROECONOMICS_DATA_PATH=./data/macroeconomics_data/
PUBLIC_FINANCE_CATALOG_PATH=./data/public_finance.ducklake
PUBLIC_FINANCE_DATA_PATH=./data/public_finance_data/

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Rate limiting
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_MS=900000

# Logging
LOG_LEVEL=warn
LOG_TO_FILE=true
LOG_DIR=./logs
```

Copy `.env.example` to `.env` and fill in the values appropriate for your deployment.
