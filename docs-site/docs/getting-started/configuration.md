---
title: Configuration
sidebar_position: 2
---

# Configuration System

All configuration lives in the `config/` directory as YAML files. They are deep-merged at startup by `src/utils/config-loader.ts`.

## File overview

| File | Purpose |
|------|---------|
| `config/main.yaml` | Application name and environment |
| `config/api.yaml` | Port, CORS, pagination, timeouts, data loaders |
| `config/database.yaml` | DuckLake catalog paths and connection pool |
| `config/security.yaml` | Rate limiting, complexity, depth limits, sanitization |
| `config/cache.yaml` | Redis connection and per-type TTL values |
| `config/logging.yaml` | Log level, transports, sampling |
| `config/security-patterns.yaml` | Regex patterns for input validation |
| `config/test/` | Environment-specific overrides for tests |

## Environment variable substitution

Every YAML value supports the `${VAR:-default}` syntax:

```yaml
API:
  PORT: ${PORT:-4000}          # uses $PORT env var, falls back to 4000
  DOMAIN: ${API_DOMAIN:-'https://your-production-domain.com'}
```

Set variables in your `.env` file (loaded via `dotenv`) or inject them from your deployment environment.

## Environment-specific values

Some settings have separate `development` and `production` keys:

```yaml
SECURITY:
  MAX_QUERY_DEPTH:
    development: 15
    production: 7
```

The config loader reads `NODE_ENV` and picks the matching branch automatically.

## Loading order

1. `config/main.yaml`
2. `config/api.yaml`, `config/database.yaml`, `config/security.yaml`, `config/cache.yaml`, `config/logging.yaml`
3. `config/test/*.yaml` (only when `NODE_ENV=test`)
4. Environment variables override YAML values where `${VAR}` substitution is used

## Adapting the template to your catalogs

The most important changes when using this template:

1. **Add your catalog paths** in `config/database.yaml` or via environment variables
2. **Set your domain** in `config/api.yaml` (`API.DOMAIN` and `API.CORS.ORIGINS.production`)
3. **Tune rate limits** in `config/security.yaml` (`SECURITY.RATE_LIMIT`)
4. **Configure Redis** in `config/cache.yaml` or via `REDIS_HOST` / `REDIS_PORT` env vars

For a detailed reference of every key, see the [Configuration Reference](../configuration/overview) section.
