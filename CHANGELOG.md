# Changelog

## [0.3.0](https://github.com/qbolliet/dashboard-template-api/compare/v0.2.0...v0.3.0) (2026-10-17)


### ⚠ BREAKING CHANGES

* compareAggregatedFacts takes groupBy: [GroupByInput!] and
* make aggregates NULL-safe and widen counters
* the x-catalog-id / x-schema-id HTTP headers no longer route requests; catalog/schema targeting is GraphQL-argument only. CORS origins for production now come from CORS_ORIGINS (JSON array), empty by default.
* BIGINT, UBIGINT, HUGEINT and DECIMAL values that were JSON strings are now numbers when Number.isSafeInteger holds (decimal strings
* Metadata fields are camelCase (sqlType, isCategorical, isPrimaryKey) and the NOT NULL columns are non-nullable. `aggregation` no longer defaults to SUM in the SDL. Queries against a schema without a supported dataset_metadata now fail with SCHEMA_VERSION_UNSUPPORTED.
* getDimensionTable, Dimension, DimensionDetail, Fact.dimensionDetails, AggregatedFact.keyLabel, ComparedFact.keyLabel, CatalogSchemaInfo.dimensionNames et Metadata.python_type sont supprimés sans dépréciation (projet non publié, spec bdd §8). Fact expose { keys, measures } avec le type FieldValue en remplacement de Measure, et getSharedDimensions est renommé getSharedFields.
* `filters: String` is removed and `structuredFilters` is now a `FilterNode` (root = non-empty group) on getFactTable, getFactTableWithMetadata, getAggregatedFacts and getAggregatedFactsWithMetadata. The `Filter` input type no longer exists.

### Features

* add getAggregates with multiple measures, time grains and a long format ([88c4fc3](https://github.com/qbolliet/dashboard-template-api/commit/88c4fc31da62b0728d8281573808e0ab11184305))
* add on-demand column statistics (FieldStats) ([7df0f5c](https://github.com/qbolliet/dashboard-template-api/commit/7df0f5c838bc4c3e41e69a303da6df7adc0f49e2))
* add REST bulk export endpoint (arrow/csv/parquet) ([faff6fe](https://github.com/qbolliet/dashboard-template-api/commit/faff6fe34a07c983e14da8a7ad9dd057533f2677))
* aggregate before comparing datasets, support any measure and aggregated exports ([472dcc1](https://github.com/qbolliet/dashboard-template-api/commit/472dcc1675b9222aaff9f98ce0ac8d82c91340eb))
* detect catalog updates on every replica and version cache keys by snapshot ([0c2e9a3](https://github.com/qbolliet/dashboard-template-api/commit/0c2e9a313b1f32e24344d48d99c3b00cf1ee9edd))
* discover schemas by default, accept every database type and order columns physically ([48a067e](https://github.com/qbolliet/dashboard-template-api/commit/48a067eab219a2b98b059f3ef13db442f02cba99))
* drop the dimension layer and move to the three-table schema ([66d4cb8](https://github.com/qbolliet/dashboard-template-api/commit/66d4cb89daeaeabef1b7cdd47100601545a26a48))
* **export:** embed column metadata, type 128-bit integers and release connections early ([36c4953](https://github.com/qbolliet/dashboard-template-api/commit/36c4953109d2eafab0f8465088e927dc3f161b27))
* **export:** signal truncation, resume beyond MAX_ROWS and accept filters in a POST body ([fa84342](https://github.com/qbolliet/dashboard-template-api/commit/fa8434211c44f545b3d6828e0e194d1df106e339))
* expose code labels (labelFor) across metadata, select options and aggregates ([c3ae9d3](https://github.com/qbolliet/dashboard-template-api/commit/c3ae9d34913ed793405f564cec78eff98afea240))
* expose column metadata on datasets and guarantee JSON value types ([6f0cdbd](https://github.com/qbolliet/dashboard-template-api/commit/6f0cdbd30d93a0295c7dddcad6e4b5c19bd900c9))
* expose the full metadata contract, dataset info and deterministic ordering ([da541f7](https://github.com/qbolliet/dashboard-template-api/commit/da541f7678cdc031a30025ac9233388f327b0528))
* **filters:** add NOT on nodes and extend the operation set ([abec62b](https://github.com/qbolliet/dashboard-template-api/commit/abec62bd61fe8f9f79f68d451661c8fca2174af9))
* **filters:** extend FilterConnector with six derived connectors ([80874f8](https://github.com/qbolliet/dashboard-template-api/commit/80874f8476ac00ae8ff49c03dc01d9054fc5ed42))
* replace raw SQL filters with parameterized filter tree ([5b87aab](https://github.com/qbolliet/dashboard-template-api/commit/5b87aabf49d626e0fc4e8da72c18fce29fc6f670))
* **schema:** expose typeFamily and the allowed filter operations of each column ([72f5820](https://github.com/qbolliet/dashboard-template-api/commit/72f58203b328f8fe0b3ddce1edc04354f8c66b4d))


### Bug Fixes

* adapt selectoptions to new schema ([6b9cfac](https://github.com/qbolliet/dashboard-template-api/commit/6b9cface7e67280da2949b5dbb0e4809eea54566))
* **cache:** make invalidation honour the Redis key prefix and resolved key segments ([9bfb22b](https://github.com/qbolliet/dashboard-template-api/commit/9bfb22b9560b987ef4819c7609ac6b6f2f4922fc))
* default numeric operations ([9e1dd81](https://github.com/qbolliet/dashboard-template-api/commit/9e1dd81ed24e528d46406adf5f8f48e5777f6420))
* detect added and removed schemas in the catalog freshness probe ([d04b87b](https://github.com/qbolliet/dashboard-template-api/commit/d04b87b4bca4d3b25c0ed88ac9c8a1dd4dc3c026))
* drain HTTP and exports on shutdown and protect internal endpoints ([a8dbd91](https://github.com/qbolliet/dashboard-template-api/commit/a8dbd91cf3427afa91e500b5908c2b5960f5e9d5))
* make aggregates NULL-safe and widen counters ([dc1b4e5](https://github.com/qbolliet/dashboard-template-api/commit/dc1b4e5a302d41752cacdcef91e9ca7bcd87117c))
* propagate loader errors and check every identifier against metadata ([6b568b1](https://github.com/qbolliet/dashboard-template-api/commit/6b568b121759a5b07bc7355797ab49362b3e9123))
* **security:** drop text pattern checks, score every root field and expose client errors ([fe9f1f0](https://github.com/qbolliet/dashboard-template-api/commit/fe9f1f03e28b23ed9c5c11e7fbc4a5843728690a))
* **security:** identify clients by trusted-proxy IP and harden admin routes ([db95fd7](https://github.com/qbolliet/dashboard-template-api/commit/db95fd75e9c3f9176bb4bdb1926856a8f5cefbc2))
* **security:** restore validation, relax body limits, fix complexity ([1ee1d9c](https://github.com/qbolliet/dashboard-template-api/commit/1ee1d9cd2eb39cc28804d7e2475972313d5fba73))
* **security:** wire rate limiting and complexity analysis into the request path ([416600f](https://github.com/qbolliet/dashboard-template-api/commit/416600ff50351d7fed1b693ccd651569771024e4))
* target catalogs by arguments only and configure CORS origins explicitly ([3a1c5fb](https://github.com/qbolliet/dashboard-template-api/commit/3a1c5fb764aa915e4192e04812a2be901bfe58f6))


### Performance Improvements

* bound the DuckDB pool with a FIFO queue and consult the cache before acquiring ([5670571](https://github.com/qbolliet/dashboard-template-api/commit/56705712e722bea923eab510ae090967e263966a))

## [0.2.0](https://github.com/qbolliet/dashboard-template-api/compare/v0.1.0...v0.2.0) (2026-05-29)


### Features

* add endpoints for parcimonious cache invalidation and catalog reload in multi-schema context ([80f4843](https://github.com/qbolliet/dashboard-template-api/commit/80f48431a1ec2ddb4063305caaa4218fdcb35322))
* add multi-schema catalog support ([398fee3](https://github.com/qbolliet/dashboard-template-api/commit/398fee373b24faa290d963f7853257b0b65a6088))
* cascading catalog inspection queries ([67d2da9](https://github.com/qbolliet/dashboard-template-api/commit/67d2da9706a147941343dfa46492822330214559))
* multi measure type for fact requests (before was only "value") ([56bfd33](https://github.com/qbolliet/dashboard-template-api/commit/56bfd33230e0f477dcab2a83851762f53de362f9))


### Bug Fixes

* asymetric join ([92588fe](https://github.com/qbolliet/dashboard-template-api/commit/92588febbeca512d6899138efeda4dc15c4576c2))
* dimension table resolution for cross-database queries ([950294b](https://github.com/qbolliet/dashboard-template-api/commit/950294b155cab21ac6d6ccfe85f75ecc5ad87de8))
* schema validation ([170187d](https://github.com/qbolliet/dashboard-template-api/commit/170187d8ae5e0218b275537e1bd3aacd1a7c3e03))

## 0.1.0 (2026-05-23)


### Features

* postgres catalog integration ([b118796](https://github.com/qbolliet/dashboard-template-api/commit/b118796fd53d918f3feca41e54d16d5d432daade))
* reload catalogs endpoint ([fddd62e](https://github.com/qbolliet/dashboard-template-api/commit/fddd62e82253741c5a3678ab60e225a3f81e19df))


### Miscellaneous Chores

* reset release history and bootstrap at v0.1.0 ([23cf17e](https://github.com/qbolliet/dashboard-template-api/commit/23cf17eb4871101738c759ac44d11b7058a6f6da))

## Changelog
