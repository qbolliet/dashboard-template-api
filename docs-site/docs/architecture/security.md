---
title: Security
sidebar_position: 2
---

# Security Architecture

The API applies security checks in layers, from the outermost HTTP middleware down to field-level resolution. Each layer is independently configurable.

## Layer 1 — HTTP middleware

Applied by Express before any GraphQL processing:

- **CORS** — only allows origins listed in `config/api.yaml` (`API.CORS.ORIGINS`)
- **HSTS** — `Strict-Transport-Security` header (configurable max-age)
- **Compression** — response compression reduces data transfer but does not expose new attack surface
- **Request size limits** — body size, field size, and field count caps prevent oversized payloads

## Layer 2 — Rate limiter (`src/security/rate-limiter.ts`)

Two sliding-window counters are maintained in Redis per client IP:

| Window | Purpose |
|--------|---------|
| Sustained (15 min) | Prevents data scraping and bulk harvesting |
| Burst (1 min) | Prevents sudden request spikes |

When either limit is exceeded the request is rejected with HTTP `429` before it reaches GraphQL.

If the API runs behind a reverse proxy, configure `TRUSTED_PROXIES` so that the real IP is read from `x-forwarded-for` rather than the proxy IP.

## Layer 3 — GraphQL validation rules

Applied by Apollo Server during the validation phase (before execution):

### Depth limiter (`src/security/depth-limit.ts`)

Rejects queries whose selection set nesting exceeds `MAX_QUERY_DEPTH` (7 in production, 15 in development). This prevents deeply recursive queries that could consume disproportionate resources.

### Complexity analyser (`src/security/complexity-analyzer.ts`)

Assigns a numeric cost to every field in the query:

- Scalar fields: 0 points
- Object fields: 1 point
- List fields: child cost × `LIST_FACTOR` (10)
- Depth penalty: total × `DEPTH_FACTOR` (1.5)
- Per-operation surcharge via `CUSTOM_SCORES`

Queries exceeding `MAX_ALLOWED` (100) are rejected before execution. Introspection queries are given a very high cost (1 000) to prevent automated schema scraping in production.

## Layer 4 — Input sanitization (`src/security/input-sanitizer.ts`)

All string arguments are processed through two sanitizers before reaching any resolver:

1. **XSS sanitizer** — strips HTML tags and event handlers using the `xss` library
2. **SQL injection detector** — pattern-matches against known injection strings

Inputs exceeding `MAX_STRING_LENGTH` (1 000 characters) are truncated. The sanitizer runs once per request on the parsed variables object.

## Layer 5 — Pattern validator (`src/security/pattern-validator.ts`)

Validates structured filter arguments against the regex rules defined in `config/security-patterns.yaml`. Filters that reference disallowed field names or contain forbidden value patterns are rejected with a validation error.

## Layer 6 — Field-level middleware

Registered as an Apollo Server plugin, the field middleware:
- Records per-field execution time
- Logs slow resolvers
- Enforces per-field access rules (extensible for future per-field authorization)

## Security manager (`src/security/manager.ts`)

`SecurityManager` is the single entry point that orchestrates all the above checks in the correct order. `src/server.ts` creates one instance at startup and passes it to both the Express middleware stack and the Apollo context factory.

## Error handling

- **Production**: errors are formatted with a unique `errorId` (UUID). Stack traces and internal details are stripped. The `errorId` is logged server-side so incidents can be correlated.
- **Development**: full error details including stack traces are returned to the client.

Error IDs are included in the GraphQL `extensions` object:

```json
{
  "errors": [
    {
      "message": "Query too complex",
      "extensions": { "errorId": "3f2a1b…", "code": "QUERY_TOO_COMPLEX" }
    }
  ]
}
```
