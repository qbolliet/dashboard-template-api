/**
 * Writes the tracked GraphQL SDL (`schema.graphql`, repository root) from the
 * TypeScript typedefs in `src/`.
 *
 * This file is the API contract: it is compared with the last release by
 * `npm run schema:diff`, verified up to date by `npm run schema:check`, and attached
 * to every GitHub Release. It is distinct from `docs-site/static/schema.graphql`,
 * an ignored build artifact of the documentation (see `npm run docs:schema`).
 *
 * The output is deterministic: same source → same bytes (LF line endings, trailing
 * newline, no timestamp).
 *
 * Usage:
 *   npm run schema:generate
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { printSchema } from 'graphql';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only the merged typedefs are imported — no resolver deps (DuckDB, Redis, etc.).
import { typeDefs } from '../src/schema/typedefs/index.js';

// makeExecutableSchema and printSchema must share the same `graphql` instance,
// otherwise the schema is rejected as "from another module or realm". Both are
// imported statically from the repository root, where `graphql` is deduped.
const schema = makeExecutableSchema({ typeDefs });
const sdl = printSchema(schema).replace(/\r\n/g, '\n') + '\n';

const outputPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.graphql');
writeFileSync(outputPath, sdl, { encoding: 'utf8' });

console.log(`Schema SDL written to ${outputPath}`);
