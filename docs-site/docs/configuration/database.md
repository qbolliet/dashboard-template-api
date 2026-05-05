---
title: database.yaml
sidebar_position: 3
---

# `config/database.yaml`

Defines the DuckLake catalogs the API serves and the connection pool settings.

## Catalogs

```yaml
CATALOGS:
  default:
    PATH: ${DEFAULT_CATALOG_PATH:-../dashboard-template-database/outputs/default.ducklake}
    DATA_PATH: ${DEFAULT_DATA_PATH:-../dashboard-template-database/outputs/default_data/}
    READ_ONLY: ${DEFAULT_READ_ONLY:-true}
    SCHEMA: ${DEFAULT_SCHEMA:-main}
  macroeconomics:
    PATH: ${MACROECONOMICS_CATALOG_PATH:-...}
    DATA_PATH: ${MACROECONOMICS_DATA_PATH:-...}
    READ_ONLY: ${MACROECONOMICS_READ_ONLY:-true}
    SCHEMA: ${MACROECONOMICS_SCHEMA:-main}
  public_finance:
    PATH: ${PUBLIC_FINANCE_CATALOG_PATH:-...}
    DATA_PATH: ${PUBLIC_FINANCE_DATA_PATH:-...}
    READ_ONLY: ${PUBLIC_FINANCE_READ_ONLY:-true}
    SCHEMA: ${PUBLIC_FINANCE_SCHEMA:-main}
```

Each catalog entry requires:

| Key | Description |
|-----|-------------|
| `PATH` | Path to the `.ducklake` catalog file |
| `DATA_PATH` | Path to the associated data directory |
| `READ_ONLY` | Should always be `true` in production |
| `SCHEMA` | DuckDB schema to query (`main` by default) |

### Adding a catalog

1. Add a new key under `CATALOGS` in `config/database.yaml`
2. Set the path env vars or hardcode the paths
3. Restart the server — the new catalog will be registered automatically

## Routing

```yaml
DATABASE_ROUTING:
  DEFAULT_DATABASE: ${DEFAULT_DATABASE:-default}
  ALLOWED_DATABASES: ${ALLOWED_DATABASES:-["default", "macroeconomics", "public_finance"]}
  ALLOW_CROSS_DATABASE_QUERIES: ${ALLOW_CROSS_DATABASE_QUERIES:-false}
```

| Key | Default | Description |
|-----|---------|-------------|
| `DEFAULT_DATABASE` | `default` | Catalog used when no `database` argument or header is provided |
| `ALLOWED_DATABASES` | all three | Whitelist of catalog IDs that can be queried |
| `ALLOW_CROSS_DATABASE_QUERIES` | `false` | Enable `compareFacts` / `compareAggregatedFacts` |

:::tip
Set `ALLOW_CROSS_DATABASE_QUERIES=true` to enable the cross-database comparison queries.
:::

## Connection pool

```yaml
DATABASE:
  POOL:
    MAX_CONNECTIONS: ${DB_MAX_CONNECTIONS:-5}
    ACQUIRE_TIMEOUT: ${DB_ACQUIRE_TIMEOUT:-60000}
    POOL_RETRY_DELAY: ${DB_POOL_RETRY_DELAY:-500}
```

| Key | Default | Description |
|-----|---------|-------------|
| `MAX_CONNECTIONS` | `5` | Maximum concurrent DuckDB connections per catalog |
| `ACQUIRE_TIMEOUT` | `60 000 ms` | Maximum wait for a connection from the pool |
| `POOL_RETRY_DELAY` | `500 ms` | Delay between pool acquire retries |

## S3 storage (optional)

```yaml
S3:
  ENABLED: ${S3_ENABLED:-false}
  ACCESS_KEY: ${AWS_ACCESS_KEY_ID:-}
  SECRET_KEY: ${AWS_SECRET_ACCESS_KEY:-}
  REGION: ${AWS_REGION:-eu-west-1}
  ENDPOINT: ${S3_ENDPOINT:-}
```

Set `S3_ENABLED=true` to enable DuckDB's S3 extension for reading data files hosted in object storage.
