---
title: Overview
sidebar_position: 1
---

# Deployment Overview

This section covers running the API in production. Three deployment modes are supported:

| Mode | When to use |
|------|-------------|
| **Local / dev** | Single process via `npm run dev` — see [Getting Started](../getting-started/installation) |
| **Docker** | Single-host setup, CI integration, simple ops — see [Docker](./docker) |
| **Kubernetes (Helm)** | Production, scaling, reproducible installs — see [Kubernetes & Helm](./kubernetes-helm) |

## Architecture

```
                         ┌───────────────────────┐
                         │  External Python      │
                         │  DuckLake updater     │
                         └──────────┬────────────┘
                                    │ POST /api/cache/invalidate-all
                                    │ x-admin-key
                                    ▼
   ┌──────────┐         ┌──────────────────────────┐
   │ Internet │ ──────▶ │ Ingress (TLS via         │
   └──────────┘         │ cert-manager)            │
                        └─────────────┬────────────┘
                                      │
                                      ▼
                        ┌──────────────────────────┐
                        │  Service (ClusterIP)     │
                        └─────────────┬────────────┘
                                      │
                                      ▼
                ┌──────────────────────────────────────┐
                │  Deployment — N replicas (HPA 2..6)  │
                │  ┌────────────────┐                  │
                │  │ API container  │ /health /ready   │
                │  │ Node 20        │ /metrics         │
                │  └───────┬────────┘                  │
                └──────────┼───────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       ┌───────────┐  ┌─────────┐  ┌───────────┐
       │ S3 bucket │  │ Redis   │  │ ConfigMap │
       │ DuckLake  │  │ master  │  │ + Secret  │
       │ catalogs  │  │ (Bitnami│  │           │
       │ + parquet │  │  chart) │  │           │
       └───────────┘  └─────────┘  └───────────┘
```

## Components

| Component | Purpose | Notes |
|-----------|---------|-------|
| API container | Apollo + Express + DuckDB | Stateless, scales horizontally |
| Redis | Cache for query results, metadata, dimensions | Provided by Bitnami sub-chart, or external |
| S3 bucket | Stores `.ducklake` catalogs + parquet data files | Read via DuckDB httpfs |
| Ingress | TLS termination + routing | nginx-ingress recommended |
| ConfigMap | Non-secret env (catalog paths, NODE_ENV, REDIS_HOST…) | Generated from `values.config` |
| Secret | AWS keys, ADMIN_API_KEY | Inline (dev) or external (ESO/SealedSecrets) |
| Bitnami Redis Secret | Auto-generated Redis password | Persists across upgrades |

## Image registry

The official image is published to GitHub Container Registry on every push to `main` and on every `v*.*.*` tag:

```
ghcr.io/qbolliet/dashboard-template-api:latest
ghcr.io/qbolliet/dashboard-template-api:sha-<short>
ghcr.io/qbolliet/dashboard-template-api:<semver>
```

Pulls are unauthenticated (the package is public).

## Prerequisites

| Tool | Version | Required for |
|------|---------|--------------|
| Docker | 24+ | All deployment modes |
| Kubernetes | 1.27+ | Helm install |
| Helm | 3.13+ | Helm install |
| ingress-nginx | 1.10+ | Public exposure |
| cert-manager | 1.14+ | Auto-issued TLS (optional) |
| S3-compatible bucket | — | DuckLake catalog storage |

## Configuration model

- **Most settings live in `config/*.yaml`** with sensible defaults (timeouts, rate limits, complexity limits, pagination, etc.).
- **Deployment-specific values** (catalog paths, Redis host, AWS region) override YAML defaults via env vars.
- **Secrets** (AWS keys, `ADMIN_API_KEY`, Redis password) are injected via Kubernetes `Secret` resources.

See [Configuration Reference](../configuration/overview) for the complete list of YAML keys.

## Cache invalidation

When DuckLake catalogs are refreshed, the API's Redis cache must be invalidated. This is done via authenticated HTTP endpoints — see [Cache invalidation](./cache-invalidation).
