---
title: Building the Documentation
sidebar_position: 4
---

# Building the Documentation

The documentation site is built from three sources: TypeDoc (TypeScript API), a GraphQL SDL schema, and hand-written Markdown pages. The steps below show how to generate and serve the full site locally.

## Prerequisites

| Tool | Notes |
|------|-------|
| Node.js ≥ 18 | Required by Docusaurus and TypeDoc |
| npm dependencies installed | `npm install` at repo root + `npm install` in `docs-site/` |

Install both dependency sets before running any documentation command:

```bash
npm install
npm --prefix docs-site install
```

## Documentation scripts

All documentation scripts are defined in the root `package.json` and run from the repo root.

| Script | What it does |
|--------|--------------|
| `npm run docs:typedoc` | Generates the Code Reference pages from TypeScript source into `docs-site/code-reference/` |
| `npm run docs:schema` | Exports the GraphQL schema SDL to `docs-site/static/schema.graphql` |
| `npm run docs:graphql` | Generates the GraphQL API pages from the SDL into `docs-site/docs/graphql-api/` |
| `npm run docs:build` | Runs all three steps above then builds the static Docusaurus site |

## Build the full site (production)

```bash
# From the repo root
npm run docs:build
```

The static output is written to `docs-site/build/`. Serve it locally to preview the production build:

```bash
npm --prefix docs-site run serve
# → http://localhost:3000/dashboard-template-api/
```

## Development server (live reload)

For editing hand-written pages, the Docusaurus dev server provides hot reload.  
Generate the auto-built sections first, then start the dev server:

```bash
npm run docs:typedoc
npm run docs:schema
npm run docs:graphql
npm --prefix docs-site run start
# → http://localhost:3000/dashboard-template-api/
```

:::note
The Code Reference and GraphQL API sections require their respective generation steps (`docs:typedoc`, `docs:graphql`) to be run at least once before they appear in the dev server.
:::

## Individual generation steps

Run individual steps when you only need to refresh one section:

```bash
# Refresh Code Reference after modifying TypeScript source
npm run docs:typedoc

# Refresh GraphQL API pages after modifying the schema
npm run docs:schema && npm run docs:graphql
```

## Docusaurus CLI reference

These commands run from the `docs-site/` directory (prefix with `npm --prefix docs-site run`):

| Command | Description |
|---------|-------------|
| `start` | Start dev server with live reload |
| `build` | Build static site to `docs-site/build/` |
| `serve` | Serve the static build locally |
| `clear` | Clear Docusaurus cache (`.docusaurus/` and `build/`) |
