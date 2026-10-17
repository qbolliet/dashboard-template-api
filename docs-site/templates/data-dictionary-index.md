---
id: data-dictionary-index
title: Data Dictionary
sidebar_label: Overview
slug: /
---

# Data Dictionary

This section is generated from the running API (`getCatalogs`, `getDatasetInfo` and
`getCatalogSchema`): one page per catalog and schema, with the columns grouped by family,
the label columns next to their code and the column hierarchies.

If you are seeing this placeholder, the generator has not reached an API yet. From the
repository root:

```bash
API_URL=http://localhost:4000/graphql npm run docs:dictionary
# or, against the test database (no running API needed):
npm run test:setup && npm run docs:dictionary:test
```

The build of this site never fails on an unreachable API: it logs a warning and keeps the
pages of the previous run.
