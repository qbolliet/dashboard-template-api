---
title: Docker
sidebar_position: 2
---

# Docker

The API ships as a multi-stage `node:20-bookworm-slim` image, ~250 MB compressed. It runs as non-root (`uid 10001`), supervises the Node process with `tini`, and exposes a healthcheck on `/health`.

## Pull the image

```bash
docker pull ghcr.io/qbolliet/dashboard-template-api:latest
```

Available tags:

- `:latest` — head of `main`
- `:sha-<short>` — exact commit
- `:<semver>` (e.g. `:1.2.3`, `:1.2`) — released versions

## Run with `docker run`

Minimal command (assumes Redis on the host):

```bash
docker run --rm -p 4000:4000 \
  --name dta-api \
  -e NODE_ENV=production \
  -e ENVIRONMENT=production \
  -e DEFAULT_CATALOG_TYPE=file \
  -e DEFAULT_CATALOG_PATH=s3://my-bucket/default.ducklake \
  -e DEFAULT_DATA_PATH=s3://my-bucket/default_data/ \
  -e DEFAULT_READ_ONLY=true \
  -e DEFAULT_SCHEMAS='["main"]' \
  -e DEFAULT_CATALOG=default \
  -e ALLOWED_CATALOGS='["default"]' \
  -e S3_ENABLED=true \
  -e AWS_ACCESS_KEY_ID=... \
  -e AWS_SECRET_ACCESS_KEY=... \
  -e AWS_REGION=eu-west-1 \
  -e REDIS_HOST=host.docker.internal \
  -e REDIS_PORT=6379 \
  -e ADMIN_API_KEY=$(openssl rand -hex 32) \
  ghcr.io/qbolliet/dashboard-template-api:latest
```

Per-catalog env vars follow the `<NAME_UPPER>_*` convention:
`<NAME>_CATALOG_TYPE`, `<NAME>_CATALOG_PATH`, `<NAME>_DATA_PATH`,
`<NAME>_READ_ONLY`, `<NAME>_SCHEMAS` (and `<NAME>_PG_HOST` / `_PG_PORT` /
`_PG_DATABASE` / `_PG_USER` / `_PG_PASSWORD` for Postgres-backed catalogs).
Add another catalog by listing its name in `ALLOWED_CATALOGS` and exporting
its env-var block.

`SCHEMAS` is a JSON-encoded list. Use `'["main", "staging"]'` for a
multi-schema catalog; omit to let the API discover schemas at startup and
fall back to `["main"]` when none is found.

Verify it is up:

```bash
curl http://localhost:4000/health   # → {"status":"ok",...}
curl http://localhost:4000/ready    # → {"status":"ready",...}
```

## Local stack with `docker-compose`

For development against local DuckLake files, MinIO, and Redis:

```yaml
# docker-compose.yml
services:
  api:
    image: ghcr.io/qbolliet/dashboard-template-api:latest
    ports:
      - '4000:4000'
    environment:
      NODE_ENV: production
      ENVIRONMENT: production
      DEFAULT_CATALOG_TYPE: file
      DEFAULT_CATALOG_PATH: s3://dta/default.ducklake
      DEFAULT_DATA_PATH: s3://dta/default_data/
      DEFAULT_SCHEMAS: '["main"]'
      DEFAULT_CATALOG: default
      ALLOWED_CATALOGS: '["default"]'
      S3_ENABLED: 'true'
      S3_ENDPOINT: http://minio:9000
      AWS_ACCESS_KEY_ID: minioadmin
      AWS_SECRET_ACCESS_KEY: minioadmin
      AWS_REGION: us-east-1
      REDIS_HOST: redis
      REDIS_PORT: '6379'
      ADMIN_API_KEY: dev-key
    depends_on:
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports:
      - '9000:9000'
      - '9001:9001'
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio-data:/data
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://localhost:9000/minio/health/live']
      interval: 10s

volumes:
  minio-data:
```

```bash
docker compose up -d
docker compose logs -f api
```

## Building the image yourself

```bash
git clone https://github.com/qbolliet/dashboard-template-api
cd dashboard-template-api
docker build -t dta-api:dev .
```

The build is multi-stage:

| Stage     | Purpose                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `deps`    | Installs all npm deps + native build tools (`python3 make g++`)               |
| `build`   | Compiles TypeScript, prunes dev-deps                                          |
| `runtime` | Final slim image with `dist/`, prod `node_modules`, `config/`, `tini`, `curl` |

## Production hardening checklist

- [ ] `ADMIN_API_KEY` set to a long random value (`openssl rand -hex 32`)
- [ ] `LOG_TO_FILE=false` (the image sets this by default; logs go to stdout)
- [ ] CPU and memory limits set (via Docker `--memory`/`--cpus` or compose `deploy.resources`)
- [ ] Restart policy in place (`--restart=unless-stopped`)
- [ ] Reverse proxy in front for TLS termination (Caddy, nginx, Traefik…)
