---
id: intro
title: Toolbox
sidebar_position: 1
slug: /
---

# Toolbox

The reusable half of the documentation of the **GraphQL DuckLake API**: everything that
holds for any deployment of the template, whatever data it serves. What is specific to
one deployment — the GraphQL reference, the export endpoint, the data dictionary — lives
on the [API & Data site](https://qbolliet.github.io/dashboard-template-api/).

## What is in the Toolbox

| Section                                             | Content                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Getting Started](./getting-started/installation)   | Install the server, configure it, run the tests, build this documentation                           |
| [Deployment](./deployment/overview)                 | Docker, Kubernetes / Helm, and the nightly data refresh (`/api/catalog/reload`, cache invalidation) |
| [Configuration Reference](./configuration/overview) | Every YAML key of `config/` and its environment variable                                            |
| [Architecture](./architecture/overview)             | Security layers, caching, data loading                                                              |
| [API versioning](./api-versioning)                  | The `schema.graphql` contract, commit conventions and the deprecation policy                        |
| [Code Reference](/code-reference)                   | TypeDoc pages generated from the TypeScript sources                                                 |

## Reusing it in another project

The Toolbox pages describe the template, not its data: a project forked from the
template keeps them as they are and only regenerates the API & Data site (the GraphQL
reference from its own `schema.graphql`, the data dictionary from its own API).

The two sites are built from the same `docs-site/` package, with one Docusaurus config
each, and published together on GitHub Pages — see
[Building the documentation](./getting-started/building-the-docs).
