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
    SCHEMAS: ${DEFAULT_SCHEMAS:-["main"]}
  macroeconomics:
    PATH: ${MACROECONOMICS_CATALOG_PATH:-...}
    DATA_PATH: ${MACROECONOMICS_DATA_PATH:-...}
    READ_ONLY: ${MACROECONOMICS_READ_ONLY:-true}
    SCHEMAS: ${MACROECONOMICS_SCHEMAS:-["main"]}
  public_finance:
    PATH: ${PUBLIC_FINANCE_CATALOG_PATH:-...}
    DATA_PATH: ${PUBLIC_FINANCE_DATA_PATH:-...}
    READ_ONLY: ${PUBLIC_FINANCE_READ_ONLY:-true}
    SCHEMAS: ${PUBLIC_FINANCE_SCHEMAS:-["main"]}
```

Each catalog entry requires:

| Key         | Description                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATH`      | Path to the `.ducklake` catalog file                                                                                                                                                     |
| `DATA_PATH` | Path to the associated data directory                                                                                                                                                    |
| `READ_ONLY` | Should always be `true` in production                                                                                                                                                    |
| `SCHEMAS`   | DuckLake schemas hosted by the catalog (`["main"]` by default). First element is the default when a request omits `schema`. May be a YAML list or a JSON-encoded string from an env var. |

### Adding a catalog

1. Add a new key under `CATALOGS` in `config/database.yaml`
2. Set the path env vars or hardcode the paths
3. Restart the server — the new catalog will be registered automatically

### Multi-schema catalogs

A catalog can host **one or several schemas**. The first element of `SCHEMAS`
is the default schema used when a GraphQL request omits the `schema` argument.

```yaml
CATALOGS:
  default:
    PATH: ...
    DATA_PATH: ...
    SCHEMAS: ['main', 'staging'] # 'main' is the default
```

How the API treats `SCHEMAS`:

1. **At startup** the API queries `information_schema.schemata` on the live
   DuckLake instance to discover what each catalog actually exposes.
2. If `SCHEMAS` is **explicitly set**, it acts as an **allow-list**: only the
   intersection (configured ∩ discovered) is exposed. Configured-but-missing
   schemas trigger a warning in the logs and are simply ignored at runtime.
3. If `SCHEMAS` is **absent**, the discovered list is adopted as-is (falls
   back to `["main"]` when discovery returns nothing).

Routing in resolvers:

- GraphQL argument: `getFactTable(catalog: "default", schema: "staging") { … }`
- HTTP header: `X-Schema-ID: staging` (paired with `X-Catalog-ID`)
- The schema argument is validated against the per-catalog allow-list — an
  unknown schema returns a `GraphQLError` with the list of allowed values.

Reload semantics: after `POST /api/catalog/reload` or
`POST /api/catalog/reload/{name}`, the discovery query is re-run and the
allow-list is re-reconciled. No restart needed.

## Routing

```yaml
CATALOG_ROUTING:
  DEFAULT_CATALOG: ${DEFAULT_CATALOG:-default}
  ALLOWED_CATALOGS: ${ALLOWED_CATALOGS:-["default", "macroeconomics", "public_finance"]}
  ALLOW_CROSS_CATALOG_QUERIES: ${ALLOW_CROSS_CATALOG_QUERIES:-false}
```

| Key                           | Default   | Description                                                   |
| ----------------------------- | --------- | ------------------------------------------------------------- |
| `DEFAULT_CATALOG`             | `default` | Catalog used when no `catalog` argument or header is provided |
| `ALLOWED_CATALOGS`            | all three | Whitelist of catalog IDs that can be queried                  |
| `ALLOW_CROSS_CATALOG_QUERIES` | `false`   | Enable `compareFacts` / `compareAggregatedFacts`              |

:::tip
Set `ALLOW_CROSS_CATALOG_QUERIES=true` to enable the cross-catalog comparison queries.
:::

## Connection pool

```yaml
DATABASE:
  POOL:
    MAX_CONNECTIONS: ${DB_MAX_CONNECTIONS:-5}
    ACQUIRE_TIMEOUT: ${DB_ACQUIRE_TIMEOUT:-60000}
    POOL_RETRY_DELAY: ${DB_POOL_RETRY_DELAY:-500}
```

| Key                | Default     | Description                                       |
| ------------------ | ----------- | ------------------------------------------------- |
| `MAX_CONNECTIONS`  | `5`         | Maximum concurrent DuckDB connections per catalog |
| `ACQUIRE_TIMEOUT`  | `60 000 ms` | Maximum wait for a connection from the pool       |
| `POOL_RETRY_DELAY` | `500 ms`    | Delay between pool acquire retries                |

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
