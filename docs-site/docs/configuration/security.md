---
title: security.yaml
sidebar_position: 4
---

# `config/security.yaml`

Controls all application-level security checks.

## Rate limiting

```yaml
SECURITY:
  RATE_LIMIT:
    MAX_REQUESTS: ${RATE_LIMIT_MAX_REQUESTS:-100}
    WINDOW_MS: ${RATE_LIMIT_WINDOW_MS:-900000}        # 15 minutes
    MAX_BURST_REQUESTS: ${RATE_LIMIT_BURST:-20}
    BURST_WINDOW_MS: ${RATE_LIMIT_BURST_WINDOW:-60000} # 1 minute
    SKIP_FAILED_REQUESTS: false
    TRUSTED_PROXIES: ${TRUSTED_PROXIES:-[]}
```

Two independent sliding windows are applied per client IP:

| Window | Default limit | Purpose |
|--------|---------------|---------|
| Sustained | 100 req / 15 min | Prevent data scraping |
| Burst | 20 req / 1 min | Prevent sudden spikes |

**`TRUSTED_PROXIES`** — set to `['127.0.0.1']` if a local nginx / Caddy reverse proxy is in front of the API so that the real client IP is read from `x-forwarded-for`.

## Query complexity

```yaml
SECURITY:
  COMPLEXITY:
    MAX_ALLOWED: ${MAX_QUERY_COMPLEXITY:-100}
    SCALAR_COST: 0
    OBJECT_COST: 1
    LIST_FACTOR: 10
    DEPTH_FACTOR: 1.5
    INTROSPECTION_COST: 1000
    CUSTOM_SCORES:
      getFactTable: 5
      getAggregatedFacts: 10
      getFactTableWithMetadata: 8
```

The complexity score for a query is computed as:

```
score = sum(field_costs) × depth_factor
```

Where list fields multiply their children's cost by `LIST_FACTOR`. Expensive operations carry additional base scores via `CUSTOM_SCORES`.

Queries exceeding `MAX_ALLOWED` are rejected before execution.

## Query depth

```yaml
SECURITY:
  MAX_QUERY_DEPTH:
    development: 15
    production: 7
```

The maximum nesting depth of a GraphQL selection set. Deeply nested queries are rejected to prevent abuse.

## Input sanitization

```yaml
SECURITY:
  SANITIZATION:
    ENABLE_XSS: true
    ENABLE_SQL: true
    MAX_STRING_LENGTH: ${MAX_INPUT_LENGTH:-1000}
    ALLOWED_TAGS: []
    CUSTOM_SANITIZERS: {}
```

All string inputs are:
1. Truncated to `MAX_STRING_LENGTH`
2. Stripped of XSS payloads via the `xss` library
3. Checked for SQL injection patterns

## Timeouts (complexity-based)

```yaml
TIMEOUTS:
  BASE_TIMEOUT: ${BASE_TIMEOUT:-5000}
  TIMEOUT_PER_COMPLEXITY: ${TIMEOUT_PER_COMPLEXITY:-100}
  MAX_TIMEOUT: ${MAX_TIMEOUT:-30000}
```

The execution timeout for a query scales linearly with its complexity score:

```
timeout = min(BASE_TIMEOUT + complexity × TIMEOUT_PER_COMPLEXITY, MAX_TIMEOUT)
```

## Monitoring

```yaml
SECURITY:
  MONITORING:
    SLOW_QUERY_THRESHOLD: ${SLOW_QUERY_THRESHOLD:-1000}
    LOG_ALL_METRICS: ${LOG_ALL_SECURITY_METRICS:-false}
```

Queries slower than `SLOW_QUERY_THRESHOLD` milliseconds are logged as warnings with their full context.
