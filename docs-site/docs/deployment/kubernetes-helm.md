---
title: Kubernetes & Helm
sidebar_position: 3
---

# Kubernetes & Helm

The repository ships a Helm chart at `helm/dashboard-template-api/` that provisions:

- The API `Deployment` with HPA, PDB, ingress, security context, probes
- Optional in-cluster Redis (Bitnami sub-chart)
- A `ConfigMap` for non-secret env, a `Secret` for application secrets
- A `ServiceAccount` (no token mount), `Service` (ClusterIP)

## Add the chart repo

The chart is published on every release tag (`v*.*.*`):

```bash
helm repo add dta https://raw.githubusercontent.com/qbolliet/dashboard-template-api/gh-pages-charts/
helm repo update
helm search repo dta
```

You can also install directly from the source tree (clone the repo, then `helm install api ./helm/dashboard-template-api`).

## Install

Create a `values.prod.yaml` with your overrides (everything not specified falls back to chart defaults):

```yaml
# values.prod.yaml
image:
  tag: "1.0.0"   # pin to a released version; avoid :latest in production

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: api.mydomain.org
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: api-tls
      hosts:
        - api.mydomain.org

config:
  DEFAULT_CATALOG_PATH: s3://prod-bucket/default.ducklake
  DEFAULT_DATA_PATH: s3://prod-bucket/default_data/
  DEFAULT_DATABASE: default
  ALLOWED_DATABASES: '["default"]'
  AWS_REGION: eu-west-1
  TRUSTED_PROXIES: '["10.0.0.0/8"]'

# Application secrets — production should reference an externally-managed Secret
secrets:
  existingSecret: api-secrets    # populated by ExternalSecrets / SealedSecrets / sops

resources:
  requests: { cpu: 250m, memory: 512Mi }
  limits:   { cpu: 1000m, memory: 1Gi }

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 6
  targetCPUUtilizationPercentage: 70
```

The external Secret (named `api-secrets` above) must contain at minimum:

| Key | Value |
|-----|-------|
| `AWS_ACCESS_KEY_ID` | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key |
| `S3_ENDPOINT` | S3 endpoint URL (empty for AWS) |
| `ADMIN_API_KEY` | Long random string for admin endpoints |

Install:

```bash
helm install api dta/dashboard-template-api \
  --namespace dta --create-namespace \
  -f values.prod.yaml
```

## Verify

```bash
kubectl --namespace dta rollout status deploy/api
kubectl --namespace dta get pods -l app.kubernetes.io/name=dashboard-template-api

# Without ingress, port-forward for a smoke test
kubectl --namespace dta port-forward svc/api 4000:80
curl http://localhost:4000/ready
```

## Upgrade & rollback

```bash
# upgrade to a new chart or app version
helm upgrade api dta/dashboard-template-api -n dta -f values.prod.yaml

# inspect history
helm history api -n dta

# roll back
helm rollback api <revision> -n dta
```

A `checksum/config` and `checksum/secret` annotation on the pod template ensures pods restart whenever the ConfigMap or chart-managed Secret changes — no manual restart needed.

## Redis: in-chart vs external

By default `redis.enabled: true` provisions a Redis master via the Bitnami sub-chart. The password is auto-generated and stored in `<release>-redis` (key `redis-password`); the API reads it via `valueFrom`. Persistence is enabled on an 8 GiB PVC.

For a managed Redis (AWS ElastiCache, Aiven, Upstash, etc.):

```yaml
redis:
  enabled: false

config:
  REDIS_HOST: my-redis.example.com
  REDIS_PORT: "6379"

secrets:
  data:
    # ...other secrets...
    REDIS_PASSWORD: "..."
```

## TLS via cert-manager

The chart sets `cert-manager.io/cluster-issuer: letsencrypt-prod` annotation by default. You need a working `ClusterIssuer`:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-prod }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@mydomain.org
    privateKeySecretRef: { name: letsencrypt-prod }
    solvers:
      - http01: { ingress: { class: nginx } }
```

## Autoscaling

The HPA targets 70% CPU utilization between 2 and 6 replicas by default. Tune via:

```yaml
autoscaling:
  minReplicas: 3
  maxReplicas: 12
  targetCPUUtilizationPercentage: 60
  targetMemoryUtilizationPercentage: 75   # optional
```

Each replica opens its own DuckDB connection pool, so memory grows roughly linearly with replicas. Adjust resource requests/limits accordingly.

## Image registry & pull secrets

The image is public on GHCR — no `imagePullSecrets` needed. To pull from a private mirror:

```yaml
image:
  repository: registry.mycompany.com/dta-api
  tag: "1.0.0"

imagePullSecrets:
  - name: registry-mycompany
```

## Uninstall

```bash
helm uninstall api -n dta
kubectl delete namespace dta   # if you also want to drop persistent volumes
```
