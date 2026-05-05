---
title: logging.yaml
sidebar_position: 6
---

# `config/logging.yaml`

Controls the Winston logger configuration.

## Log levels

```yaml
LOGGING:
  LEVEL:
    development: debug
    production: ${LOG_LEVEL:-warn}
```

In production the default level is `warn`. Set `LOG_LEVEL=info` or `LOG_LEVEL=debug` to increase verbosity.

## Output format

```yaml
LOGGING:
  FORMAT:
    development: simple    # human-readable with colors
    production: json       # structured JSON for log aggregators
```

## Transports

### Console

```yaml
LOGGING:
  TRANSPORTS:
    console:
      enabled: true
      colorize:
        development: true
        production: false
```

### Rotating file (all levels)

```yaml
LOGGING:
  TRANSPORTS:
    file:
      enabled: ${LOG_TO_FILE:-true}
      directory: ${LOG_DIR:-./logs}
      filename: 'api-%DATE%.log'
      datePattern: 'YYYY-MM-DD'
      maxSize: ${LOG_MAX_SIZE:-10m}
      maxFiles: ${LOG_MAX_FILES:-30}
      compress: true
```

Log files rotate daily, are compressed, and are kept for 30 days by default.

### Error file

A separate `error-%DATE%.log` file captures only `error`-level entries regardless of the global level.

## Sampling

```yaml
LOGGING:
  SAMPLING:
    enabled:
      development: false
      production: true
    rate: ${LOG_SAMPLING_RATE:-0.1}
```

In production, `info` and `debug` log lines are sampled at 10% to reduce I/O on high-traffic deployments. Errors and warnings are always logged.

## Sanitized fields

```yaml
LOGGING:
  SANITIZATION:
    enabled: true
    fields:
      - password
      - token
      - authorization
      - cookie
      - api_key
      - secret
```

Values for these fields are redacted from all log output. Add fields to this list if your requests contain other sensitive data.

## Performance monitoring

```yaml
LOGGING:
  PERFORMANCE:
    SLOW_QUERY_THRESHOLD: ${SLOW_QUERY_THRESHOLD:-1000}
    LOG_SLOW_QUERIES:
      development: true
      production: ${LOG_SLOW_QUERIES_PROD:-false}
```

Slow query logging writes a warning entry with the full query context and execution time. Enabled in development by default, opt-in in production.
