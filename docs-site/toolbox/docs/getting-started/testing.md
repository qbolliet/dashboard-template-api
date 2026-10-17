---
title: Testing
sidebar_position: 3
---

# Running Tests

The test suite uses **Jest** with TypeScript support via `ts-jest`.

## Setup

The tests require test DuckLake fixtures to be loaded before the first run:

```bash
npm run test:setup
```

This populates the test catalog files under `data/` (`test-default.ducklake`, `test-macroeconomics.ducklake`, `test-public-finance.ducklake`).

:::note
Run `test:setup` again whenever you change the test data schema or reset the `data/` directory.
:::

## Running tests

```bash
npm test                  # run all tests once
npm run test:watch        # re-run on file changes
npm run test:coverage     # run with coverage report
npm run test:all          # setup + all tests in one command
```

## Test structure

```
tests/
├── setup/                 # Jest setup and DI container
│   ├── setup.ts           # Global test setup (env, logging)
│   ├── setup-env.ts       # Environment variable defaults for tests
│   ├── setup-test-data.ts # Populate test DuckLake files
│   └── di-container.ts    # Dependency injection for testable DB manager
├── helpers/
│   └── mocks.ts           # Shared mock factories
├── unit/                  # Unit tests, mirroring src/ structure
│   ├── test_cache/
│   ├── test_db/
│   ├── test_loaders/
│   ├── test_security/
│   ├── test_schema/
│   │   ├── test_resolvers/
│   │   └── test_typedefs/
│   └── test_utils/
└── integration/
    └── comprehensive.test.ts   # End-to-end GraphQL query tests
```

## Test configuration overrides

When `NODE_ENV=test`, the config loader automatically merges the files in `config/test/`:

- `config/test/main.yaml` — sets `ENVIRONMENT: test`
- `config/test/database.yaml` — points catalogs to `data/*.ducklake` files
- `config/test/security.yaml` — relaxes rate limits and disables slow-query logging

This means tests run against real DuckLake files but with a controlled, isolated configuration.

## Manual testing

With the server running (`npm run dev`), you can run the provided manual test scripts:

```bash
node tests/manual-test.js   # run a set of predefined GraphQL queries
node tests/stress-test.js   # performance / rate-limit test
```

Apollo Sandbox is also available at **http://localhost:4000/graphql** in development mode.
