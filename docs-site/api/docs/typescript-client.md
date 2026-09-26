---
title: Consuming the API in TypeScript
sidebar_position: 5
---

# Consuming the API in TypeScript

The contract of the API is its GraphQL SDL, **`schema.graphql`**, attached to every
[GitHub Release](https://github.com/qbolliet/dashboard-template-api/releases). A TypeScript
client generates its types from that file with
[GraphQL Code Generator](https://the-guild.dev/graphql/codegen) (`@graphql-codegen`; Apollo
Codegen is deprecated), so a schema change surfaces as a compile error rather than a
runtime one.

## Setup

```bash
npm install --save-dev @graphql-codegen/cli @graphql-codegen/client-preset
```

```ts title="codegen.ts"
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  // SDL of the release the client targets. `latest` follows the newest release; pin a tag
  // (…/releases/download/v0.3.0/schema.graphql) to upgrade on your own schedule.
  schema:
    'https://github.com/qbolliet/dashboard-template-api/releases/latest/download/schema.graphql',
  documents: ['src/**/*.{ts,tsx}'],
  generates: {
    'src/gql/': {
      preset: 'client',
      config: {
        // The JSON scalar carries rows, filter values and option trees: type them yourself
        scalars: { JSON: 'unknown' },
        // Enums as string unions: `operation: 'IN'` type-checks without importing an enum
        enumsAsTypes: true,
      },
    },
  },
  ignoreNoDocuments: true,
};

export default config;
```

```bash
npx graphql-codegen          # regenerate src/gql/ — commit it, or run it in your build
```

To work offline (or from a mock server), vendor the `schema.graphql` of the release in
your repository and point `schema` at that file. Compare two releases with
`npm run schema:diff` (see [API versioning](https://qbolliet.github.io/dashboard-template-api/toolbox/api-versioning)).

## A typed query

Variables, argument types and the selected fields are all checked. The `FilterNode` input
of `structuredFilters` is generated too, with the `FilterOperation` and `FilterConnector`
enums:

```ts
import { graphql } from './gql';
import type { FilterNode } from './gql/graphql';

const FactsQuery = graphql(`
  query Facts($fields: [String!], $filter: FilterNode, $limit: Int!) {
    getFactTableWithMetadata(fields: $fields, structuredFilters: $filter, limit: $limit) {
      columns
      fields {
        name
        label
        sqlType
        unit
        displayFormat
      }
      data
      metadata {
        total
        hasNextPage
        generatedAt
      }
    }
  }
`);

const filter: FilterNode = {
  children: [
    { criterion: { variable: 'country', operation: 'IN', value: ['France', 'Spain'] } },
    { connector: 'AND', criterion: { variable: 'date', operation: 'AFTER', value: '2020-01-01' } },
  ],
};

// With Apollo Client: const { data } = useQuery(FactsQuery, { variables: { fields: ['country', 'value'], filter, limit: 100 } });
```

`data` is `unknown[]` in the generated types (`[JSON!]!`): the shape of a row depends on the
requested `fields`, which the schema cannot express. Type it at the call site, and mind
the [serialization rules](./api-guide/queries): an integer beyond 2^53 comes as a **string**,
dates as ISO strings, `NULL` as `null`.

```ts
type Numeric = number | string; // BIGINT/UBIGINT columns can exceed Number.MAX_SAFE_INTEGER

interface TradeRow {
  nc8: string;
  year: number;
  value: number;
  budget: Numeric | null;
}

const rows = result.getFactTableWithMetadata.data as TradeRow[];
```

## Typing the JSON of `getSelectOptionsTree`

`getSelectOptionsTree` returns the `JSON` scalar, so its type is `unknown`. Its shape is
documented and stable: a forest of `{ value, label, children? }` nodes, `children` being
absent on leaves.

```ts
export interface SelectOptionNode {
  value: string;
  label: string;
  children?: SelectOptionNode[];
}

const RegionTreeQuery = graphql(`
  query RegionTree($maxDepth: Int) {
    getSelectOptionsTree(fieldName: "commune", maxDepth: $maxDepth)
  }
`);

/** Narrows the JSON scalar to a well-formed option forest. */
export function isSelectOptionTree(value: unknown): value is SelectOptionNode[] {
  return (
    Array.isArray(value) &&
    value.every(
      (node) =>
        typeof node === 'object' &&
        node !== null &&
        typeof node.value === 'string' &&
        typeof node.label === 'string' &&
        (node.children === undefined || isSelectOptionTree(node.children)),
    )
  );
}

const tree = result.getSelectOptionsTree;
if (!isSelectOptionTree(tree)) throw new Error('Unexpected select options tree');
```

With `maxDepth: 2`, the tree of `region → departement → commune` has departements as roots
holding their communes, which is exactly the group-options format of a select menu:

```ts
interface SelectOption {
  value: string;
  label: string;
}

interface GroupOptions {
  group: SelectOption;
  options: SelectOption[];
}

export function toGroupOptions(tree: SelectOptionNode[]): GroupOptions[] {
  return tree.map(({ value, label, children }) => ({
    group: { value, label },
    options: (children ?? []).map((child) => ({ value: child.value, label: child.label })),
  }));
}
```

## Keeping the types in sync

- A schema pinned to a tag never changes; with `latest`, regenerate whenever a release ships.
- Each release lists its breaking changes in the changelog; a field is `@deprecated` for at
  least one minor version before removal, and `deprecated` fields are flagged by editors.
- To browse the schema, use the [GraphQL reference](./graphql-api/graphql-api) or the
  [Schema Explorer](/schema).
