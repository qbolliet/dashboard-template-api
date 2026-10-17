---
title: API versioning
sidebar_position: 5
---

# API versioning

The API has **no `/v2` URL**. The GraphQL schema evolves continuously, removals are
announced with `@deprecated`, and the **package version (SemVer) is the API version**.
Release notes live in a single place: `CHANGELOG.md`, written by release-please from
the conventional commits.

## The contract: `schema.graphql`

`schema.graphql` at the repository root is the versioned GraphQL SDL — the contract
that clients vendor (mock servers, code generation) and that CI compares between
releases.

| Command                   | Purpose                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run schema:generate` | Rewrites `schema.graphql` from the typedefs in `src/` (deterministic: same source, same bytes).                                        |
| `npm run schema:check`    | Regenerates, then fails if `schema.graphql` differs from what is committed. Run by CI on every pull request.                           |
| `npm run schema:diff`     | Diffs `schema.graphql` against the SDL of the last release tag: breaking / dangerous / non-breaking. Exit code 1 on a breaking change. |

**Any change to `src/schema/typedefs/` must ship with the regenerated
`schema.graphql` and the resolver types generated from it.** Commit them together.

| Command                 | Purpose                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run codegen`       | Rewrites `src/generated/graphql.ts` (resolver types, [GraphQL Code Generator](https://the-guild.dev/graphql/codegen)) from `schema.graphql`. |
| `npm run codegen:check` | Regenerates, then fails if `src/generated/graphql.ts` differs from what is committed. Run by CI next to `schema:check`.                      |

`src/generated/graphql.ts` is committed because the Docker build has no codegen step.
Clients generate their own types from the same SDL: see
[Consuming the API in TypeScript](https://qbolliet.github.io/dashboard-template-api/typescript-client).

Every GitHub Release carries `schema.graphql` and `schema.json` (introspection) as
assets.

:::note
`docs-site/static/schema.graphql` and `schema.json` are a different thing: ignored
build artifacts of the API & Data documentation site, derived from the root `schema.graphql` by
`npm run docs:schema`. Never commit them.
:::

## Commit convention for schema changes

Use [Conventional Commits](https://www.conventionalcommits.org/). The type decides the
next version:

| Commit                                          | Meaning                                           | Version bump (0.x) |
| ----------------------------------------------- | ------------------------------------------------- | ------------------ |
| `feat(schema): add getFieldStats query`         | New field, type, argument or enum value           | minor              |
| `fix(schema): make Metadata.label non-nullable` | Correction with no client-visible break           | patch              |
| `feat!: rename getSharedDimensions`             | Breaking change (removal, rename, narrower type…) | minor              |
| `fix!: ...`, or a `BREAKING CHANGE:` footer     | Breaking bug fix                                  | minor              |

## Deprecation and removal

A new version redesign should notice the user of the fields it alters. The typical workflow to use is the following :

1. **Deprecate first.** Mark the field, argument or enum value with `@deprecated`,
   giving the replacement, in a `feat(schema):` commit. The field keeps working.
2. **Wait at least one minor version.** The deprecation ships in release N; the
   removal cannot ship before release N+1 (minor).
3. **Remove.** The removal is a `feat!:` commit, which `schema:diff` reports as a
   breaking change and the changelog lists under _Breaking changes_.

This notice period keeps the frontend predictable.

### Example

Release 0.4.0 replaces `getFactTable(limit:)` pagination with a cursor:

```graphql
type Query {
  getFactTable(
    limit: Int! = 100
    offset: Int! = 0 @deprecated(reason: "Use `after` — offset pagination stops at MAX_OFFSET.")
    after: String
  ): PaginatedFacts
}
```

```
feat(schema): add cursor pagination to getFactTable and deprecate offset
```

`schema:diff` reports the new argument as non-breaking. Release 0.5.0 (or later)
removes the argument:

```
feat!: remove the deprecated offset argument of getFactTable

BREAKING CHANGE: use `after` instead of `offset`.
```

## CI guard

The `Schema Check` workflow runs on every pull request:

1. `npm run schema:check` — `schema.graphql` is up to date.
2. `npm run codegen:check` — `src/generated/graphql.ts` is up to date with it.
3. `npm run schema:diff` — the diff against the last release tag.

A breaking change **fails the job**, unless a commit since that tag carries a breaking
marker (`feat!:`, `fix!:` or a `BREAKING CHANGE` footer). In that case the diff is
logged as a warning, added to the job summary and posted as a pull request comment.
The scan covers the commits since the last tag rather than the pull request alone, as
the diff is cumulative: a breaking change already announced on `main` and not yet
released must not fail every later pull request.
