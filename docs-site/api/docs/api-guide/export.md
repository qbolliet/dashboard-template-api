---
title: Bulk export (REST)
sidebar_position: 4
---

# Bulk export — `GET | POST /api/export`

GraphQL is the right tool for dashboards: small pages, precise field selection,
labels and statistics. It is the wrong tool for pulling a whole dataset, for two reasons:
offset pagination stops at `MAX_OFFSET` (10 000 rows), and every value goes through
JSON serialization. The export endpoint skips both. DuckDB or Arrow writes the file
straight into the HTTP response.

```
GET  /api/export?catalog=<alias>&schema=<schema>&format=arrow|csv|parquet
POST /api/export      {"catalog": "<alias>", "schema": "<schema>", "format": "parquet", …}
```

Both methods take the same parameters and return the same file. Use GET for links and
for tools that read a URL directly (pandas, Polars, DuckDB `read_parquet('https://…')`,
Power Query). Use POST when the filters are too long for a URL (see
[Large filters](#large-filters-post)).

The endpoint is read-only and public, like the GraphQL API. It shares the GraphQL
rate-limit budget and adds its own guards (see [Guards](#guards)).

## Parameters

| Parameter     | Default                           | Description                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog`     | `CATALOG_ROUTING.DEFAULT_CATALOG` | Catalog alias.                                                                                                                                                                                                                                                 |
| `schema`      | first schema of the catalog       | Schema within the catalog.                                                                                                                                                                                                                                     |
| `fields`      | every column                      | Comma-separated columns, exported in this order: `fields=region,date,population`.                                                                                                                                                                              |
| `filters`     | none                              | URL-encoded JSON of a `FilterNode`. It is the same tree as the GraphQL `structuredFilters` argument, validated by the same rules (`MAX_DEPTH`, `MAX_CRITERIA`, operations allowed per column type).                                                            |
| `sort`        | the schema's `cluster_by`         | `col:asc,col2:desc` (direction optional, `asc` by default). Primary keys that are not named are appended as tiebreakers; without primary key, every other column is.                                                                                           |
| `format`      | `arrow`                           | `arrow`, `csv` or `parquet`.                                                                                                                                                                                                                                   |
| `limit`       | `EXPORT.MAX_ROWS`                 | Row ceiling. Capped at `EXPORT.MAX_ROWS` (5 000 000 by default). Without `limit`, an export larger than the cap is refused with a `413`; with it, the response is truncated and says so (see [Exports larger than `MAX_ROWS`](#exports-larger-than-max_rows)). |
| `after`       | none                              | Resume cursor: the `X-Next-After` header of the previous page, passed back unchanged.                                                                                                                                                                          |
| `bom`         | `0`                               | `csv` only. `1` (or `true`) prefixes the file with a UTF-8 byte order mark, which Excel on Windows needs to decode accents correctly.                                                                                                                          |
| `compression` | `snappy`                          | `parquet` only. `snappy` (fast), `zstd` (smaller, still fast) or `gzip` (smallest, slowest). Any other value is a 400.                                                                                                                                         |

Unknown parameters are rejected with a 400. A typo such as `filter=` would otherwise
silently export the whole table. So is an option given to the wrong format
(`bom` on Parquet, `compression` on CSV): nothing is silently ignored.

By default the rows follow `dataset_metadata.cluster_by`, the physical write order.
That order is deterministic and costs nothing to produce, because the data is
already stored in it. The export always completes the order into a **total** one
(primary keys, or every column for a schema without primary key), with NULLs last:
two identical requests return the same rows in the same order, which is what makes
resuming possible.

## Formats

| `format`  | `Content-Type`                        | File                                      | Types                                                                                                                                                                           |
| --------- | ------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arrow`   | `application/vnd.apache.arrow.stream` | `<catalog>_<schema>_<YYYY-MM-DD>.arrows`  | Preserved: `UBIGINT`→`Uint64`, `FLOAT`→`Float32`, `DATE`→`Date32<DAY>`, `TIMESTAMP`→`Timestamp<µs>`, `DECIMAL(p,s)`→`Decimal128(p,s)`, `HUGEINT`/`UHUGEINT`→`Decimal128(38,0)`… |
| `csv`     | `text/csv; charset=utf-8`             | `<catalog>_<schema>_<YYYY-MM-DD>.csv`     | Text, with a header row. Dates are `YYYY-MM-DD` and timestamps are ISO 8601 (`2024-03-05T10:11:12.345000`). NULL is written as an empty field. No BOM unless `bom=1`.           |
| `parquet` | `application/vnd.apache.parquet`      | `<catalog>_<schema>_<YYYY-MM-DD>.parquet` | Preserved exactly, since DuckDB writes the file natively. Snappy-compressed unless `compression` says otherwise.                                                                |

The file name is sent in `Content-Disposition: attachment`, with a UTC date. Every
successful response also carries these headers, all exposed to browsers through
`Access-Control-Expose-Headers`:

| Header          | Value                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `X-Row-Count`   | Rows in this file.                                                                                                            |
| `X-Total-Count` | Rows matching the request, `limit` aside. With `after`, the rows left from this page on.                                      |
| `X-Truncated`   | `true` when rows remain beyond this file; absent otherwise.                                                                   |
| `X-Next-After`  | With `X-Truncated`: the cursor of the next page, to pass as `after`. An opaque ASCII token, safe in a URL and in a JSON body. |

CSV and Parquet responses also carry an exact `Content-Length` (the size of the file,
BOM included), so a client can show a progress bar and detect a truncated download.
Arrow is streamed as DuckDB produces it, without a `Content-Length`.

The counts come from a `count(*)` run before the first byte. It reads only the filter
columns and does not sort, so it costs less than the export itself.

Arrow is an IPC **stream** (`.arrows`), not an IPC file. Read it with
`pyarrow.ipc.open_stream` or `apache-arrow`'s `tableFromIPC`. Download a Parquet
export before reading it: the endpoint does not serve HTTP range requests.

`HUGEINT` and `UHUGEINT` columns are written as `Decimal128(38, 0)` in Arrow, and read
back as integers of that width (`decimal128(38, 0)` in pyarrow). A value that needs
more than 38 digits (a `HUGEINT` beyond ±10^38, a `UHUGEINT` beyond 2^127) cannot be
represented: the stream is cut short, without its end marker, rather than
corrupting the column. Leave such a column out with `fields`. The other types outside the database
specification (`LIST`, `STRUCT`…) are written as `Utf8`.

Responses are never cached: `Cache-Control: no-store`. The server's gzip compression
applies to CSV, since the client sends `Accept-Encoding`. It does not apply to
Arrow or Parquet, which are already compact binary formats.

## Embedded metadata {#embedded-metadata}

A Parquet or Arrow export describes itself, so that a file kept on its own still has the
labels, units and display formats of its columns. CSV cannot carry them.

| Where                      | Key                                                                         | Content                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parquet file, Arrow schema | `database.metadata`                                                         | JSON array, one object per **exported** column, in the order of `fields`: the `metadata` row in camelCase (`name`, `label`, `sqlType`, `typeFamily`, `unit`, `displayFormat`, `isPrimaryKey`, `labelFor`, `labelFields`, `description`…). |
| Parquet file, Arrow schema | `database.dataset`                                                          | JSON object of the dataset: `label`, `description`, `source`, `updatedAt`, `schemaVersion`, `clusterBy` (same as GraphQL `DatasetInfo`).                                                                                                  |
| Arrow field                | `label`, `unit`, `displayFormat`, `description`, `isPrimaryKey`, `labelFor` | Per-field metadata. A key is absent when the value is null; `isPrimaryKey` is always there, as `"true"` or `"false"`.                                                                                                                     |

A label column keeps its link to the code column through `labelFor`
(`nc8_libelle_fr` → `nc8`), so a client can join codes and labels from the file alone.

```python
import json
import pyarrow.parquet as pq

schema = pq.read_schema("default_geography_2026-09-30.parquet")
columns = json.loads(schema.metadata[b"database.metadata"])
dataset = json.loads(schema.metadata[b"database.dataset"])
labels = {c["name"]: c["label"] for c in columns}
print(dataset["label"], dataset["updatedAt"])
```

```python
import json
import pyarrow.ipc as ipc

table = ipc.open_stream(open("default_geography_2026-09-30.arrows", "rb")).read_all()
units = {f.name: f.metadata.get(b"unit") for f in table.schema}      # per-field metadata
dataset = json.loads(table.schema.metadata[b"database.dataset"])    # schema metadata
```

```ts
import { tableFromIPC } from 'apache-arrow';

const table = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
const dataset = JSON.parse(table.schema.metadata.get('database.dataset')!);
const unit = table.schema.fields.find((f) => f.name === 'population')?.metadata.get('unit');
```

DuckDB reads the Parquet pairs with
`SELECT decode(key), decode(value) FROM parquet_kv_metadata('file.parquet')`.

## Examples

```bash
# Parquet of a whole schema
curl -OJ "http://localhost:4000/api/export?catalog=default&schema=geography&format=parquet"

# Compressed CSV: three columns, sorted by descending population
curl -OJ --compressed \
  "http://localhost:4000/api/export?catalog=default&schema=geography&format=csv&fields=commune,date,population&sort=population:desc"

# Filtered Arrow export (the filter tree is URL-encoded by curl)
curl -G -OJ "http://localhost:4000/api/export" \
  --data-urlencode "catalog=default" \
  --data-urlencode "schema=main" \
  --data-urlencode 'filters={"children":[{"criterion":{"variable":"country","operation":"IN","value":["France","Germany"]}},{"connector":"AND","criterion":{"variable":"date","operation":"ON_OR_AFTER","value":"2024-01-01"}}]}'
```

Reading an Arrow export back:

```python
import pyarrow.ipc as ipc
import urllib.request

with urllib.request.urlopen("http://localhost:4000/api/export?catalog=default&schema=main") as resp:
    table = ipc.open_stream(resp).read_all()   # types preserved
df = table.to_pandas()
```

```ts
import { tableFromIPC } from 'apache-arrow';

const res = await fetch('/api/export?catalog=default&schema=main&format=arrow');
const table = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
```

## Exporting every dataset {#every-dataset}

One export is one schema. To take the whole catalog, list the catalogs and schemas
with GraphQL, then export each schema; every file carries its own metadata.

```python
import requests

API = "http://localhost:4000"
LIST = "{ getCatalogs { id schemas { name } } }"
catalogs = requests.post(f"{API}/graphql", json={"query": LIST}).json()["data"]["getCatalogs"]

for catalog in catalogs:
    for schema in catalog["schemas"]:
        params = {"catalog": catalog["id"], "schema": schema["name"],
                  "format": "parquet", "compression": "zstd"}
        with requests.get(f"{API}/api/export", params=params, stream=True) as resp:
            if resp.status_code == 413:      # more rows than MAX_ROWS: see the paging recipe below
                print("too large:", catalog["id"], schema["name"])
                continue
            resp.raise_for_status()
            with open(f"{catalog['id']}_{schema['name']}.parquet", "wb") as out:
                for chunk in resp.iter_content(1 << 20):
                    out.write(chunk)
```

The exports are sequential on purpose: `MAX_CONCURRENT_PER_IP` (2 by default) would
answer `429` to more. A schema on an unsupported version answers `409`; catch it if the
catalog may hold one.

### Data dictionary

The data dictionary of the same catalogs, without any data, comes from one GraphQL query:

```graphql
query Dictionary {
  getCatalogs {
    id
    schemas {
      name
      info {
        label
        description
        source
        updatedAt
        schemaVersion
        clusterBy
      }
      fields {
        name
        label
        sqlType
        typeFamily
        unit
        displayFormat
        description
        family
        isPrimaryKey
        isCategorical
        parentName
        labelFor
        labelFields
      }
    }
  }
}
```

It gives the same rows as `database.metadata` and `database.dataset`, for all the
columns of each schema, not only the exported ones.

## Exports larger than `MAX_ROWS` {#exports-larger-than-max_rows}

An export never stops silently at `EXPORT.MAX_ROWS`:

- **without `limit`**, a request matching more rows than the cap is refused with
  `413 Export too large`, before any byte of the file. The `detail` gives the number
  of matching rows and the cap;
- **with `limit`** (lowered to the cap if above it), the first rows are sent with
  `X-Truncated: true`, `X-Total-Count` and `X-Next-After`.

To fetch the whole set, request pages with `limit` and pass each `X-Next-After` back
as `after`, with the other parameters unchanged, until the header disappears. The
pages concatenate to the full export in its order:

```python
import io
import pandas as pd
import requests

URL = "http://localhost:4000/api/export"
params = {"catalog": "default", "schema": "main", "format": "parquet", "limit": 1_000_000}

frames, after = [], None
while True:
    resp = requests.get(URL, params={**params, **({"after": after} if after else {})})
    resp.raise_for_status()
    frames.append(pd.read_parquet(io.BytesIO(resp.content)))
    after = resp.headers.get("X-Next-After")
    if after is None:
        break
df = pd.concat(frames, ignore_index=True)
```

Resuming uses the sort key of the last row sent, not an offset. Each page costs
the same, whatever its rank, and a page never repeats or skips a row, even if the
sort column has ties or NULLs. The cursor is tied to its order: it is refused with a
`400` under another `sort` or schema. Keep the filters unchanged too, otherwise
the pages describe different sets.

## Large filters: POST {#large-filters-post}

A long `IN` list quickly exceeds what a URL can carry. Node refuses request headers
beyond about 16 KB with a `431`, and a reverse proxy or an ingress usually stops
earlier. `POST /api/export` takes the same parameters as a JSON body, up to the
`/graphql` body limit (`REQUEST_LIMITS.MAX_REQUEST_SIZE`):

```bash
curl -OJ http://localhost:4000/api/export \
  -H 'Content-Type: application/json' \
  -d '{
    "catalog": "default",
    "schema": "main",
    "format": "parquet",
    "fields": ["country", "date", "value"],
    "filters": {"children": [{"criterion": {"variable": "country", "operation": "IN", "value": ["France", "Germany"]}}]},
    "limit": 1000000
  }'
```

The body also accepts native JSON forms: `fields` and `sort` as arrays of strings
(`["population:desc", "commune"]`), `filters` as an object, `limit` as a number. The
string forms of the GET remain valid. Parameters go in the body only: a POST with a
query string is refused, so that nothing is silently ignored. The `after` cursor
travels in the body as well.

## Indicative sizes

These were measured on the test catalog: `default.main`, 1 729 rows × 16 columns
(strings, dates, timestamps, integers, floats).

| Format                         | Size   |
| ------------------------------ | ------ |
| JSON (equivalent GraphQL body) | 655 KB |
| CSV                            | 317 KB |
| Arrow                          | 243 KB |
| Parquet                        | 47 KB  |

The second measurement uses 1 000 000 synthetic rows × 6 columns (string, date,
UBIGINT, DOUBLE, FLOAT, TIMESTAMP) on a development laptop:

| Path                                  | Time   | Size   |
| ------------------------------------- | ------ | ------ |
| API JSON converter + `JSON.stringify` | ~43 s  | 111 MB |
| Arrow (export writer)                 | ~4.7 s | 40 MB  |
| CSV (`COPY … FORMAT CSV`)             | ~2.0 s | 55 MB  |
| Parquet (`COPY … FORMAT PARQUET`)     | ~1.0 s | 14 MB  |

The JSON line leaves out the GraphQL execution itself, so the real gap is larger.
The export paths are an order of magnitude faster, and 40× faster for Parquet. Parquet
is also the smallest format and should be the default choice for analysis tools.
Use Arrow for in-memory clients (pandas, Polars, apache-arrow in the browser).

## Guards

The export bypasses the GraphQL guards (depth, complexity, pagination), so it has
its own. They are configured in the `EXPORT` section of `config/api.yaml`:

| Guard                   | Default   | Behaviour                                                                                                                                                                                                                                          |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limiter            | shared    | Same limiter instance as `/graphql`: one budget per client. `429` + `Retry-After`.                                                                                                                                                                 |
| `MAX_ROWS`              | 5 000 000 | Row ceiling of one response. Beyond it: `413` without `limit`, truncated page with `X-Truncated` and `X-Next-After` with it.                                                                                                                       |
| `MAX_CONCURRENT_PER_IP` | 2         | In-flight exports per client IP (the IP alone, so changing the User-Agent does not open more slots). `429` beyond it.                                                                                                                              |
| `MAX_CONCURRENT_TOTAL`  | 2         | In-flight exports across all clients. Each export holds a pool connection for its whole duration, and the others must stay available to GraphQL. `429` beyond it.                                                                                  |
| `TIMEOUT_MS`            | 120 000   | Budget until the first byte: the count, then the DuckDB query (CSV/Parquet) or the opening of the stream (Arrow). The query is interrupted and the client gets `504`.                                                                              |
| `TRANSFER_TIMEOUT_MS`   | 600 000   | Budget from the first byte to the end: a client that reads too slowly has its connection closed (a truncated download, never a silent partial `200`). For Arrow, DuckDB produces rows during the transfer, so this budget covers the whole stream. |
| `TMP_MIN_FREE_MB`       | 1 024     | Free space the `TMP_DIR` volume must keep. Below it, a CSV or Parquet export is refused with `507` before any work (Arrow needs no temporary file). `0` disables the check.                                                                        |

The pool connection and the concurrency slot are always released in a `finally`
block, including when the client disconnects mid-download. The DuckDB query is then
interrupted as well.

CSV and Parquet are written by DuckDB to a temporary file before being streamed:
one directory per export under `EXPORT.TMP_DIR` (system temp dir by default), removed
on every exit path. Directories left by a crashed process are purged at startup.
Size the temporary volume for at least `MAX_CONCURRENT_TOTAL` × the largest export;
`TMP_MIN_FREE_MB` refuses new exports before the volume is full.

The **pool connection is given back as soon as the file is written**, before the
transfer starts: a slow client downloading a big file no longer holds a database
connection, only its concurrency slot (which is what bounds the disk use). An Arrow
export streams straight from DuckDB and keeps its connection until the last byte.

All validation runs **before** a slot or a connection is taken, so a malformed
request costs nothing.

## Errors

Errors are JSON bodies of the form `{ "error": "<label>", "detail": "<cause>" }`.

| Status | When                                                                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Unknown format or parameter, invalid identifier, unknown column, invalid filter tree (same messages as GraphQL), invalid `limit` or `sort`, invalid `after` cursor or one issued for another sort. POST: invalid JSON, body that is not an object, parameters in the query string. |
| `404`  | Unknown catalog, or schema not served for the catalog.                                                                                                                                                                                                                             |
| `409`  | Schema written in an unsupported `schema_version` (same message as the GraphQL version guard).                                                                                                                                                                                     |
| `413`  | More rows than `EXPORT.MAX_ROWS` and no `limit` given: pass `limit`, then follow `X-Next-After` (see [Exports larger than `MAX_ROWS`](#exports-larger-than-max_rows)).                                                                                                             |
| `415`  | POST body that is not `application/json`.                                                                                                                                                                                                                                          |
| `429`  | Rate limit, or too many concurrent exports (per client or overall).                                                                                                                                                                                                                |
| `503`  | No database connection available within the pool acquisition timeout.                                                                                                                                                                                                              |
| `504`  | Export exceeded `TIMEOUT_MS` before its first byte.                                                                                                                                                                                                                                |
| `507`  | The `TMP_DIR` volume has less free space than `EXPORT.TMP_MIN_FREE_MB` (CSV and Parquet only).                                                                                                                                                                                     |

If an error happens after the body has started, the only possible signal is a
truncated download: an Arrow stream lacks its end-of-stream marker, and a CSV or Parquet
body is shorter than its `Content-Length`. That is also what a client too slow for
`TRANSFER_TIMEOUT_MS` gets.
