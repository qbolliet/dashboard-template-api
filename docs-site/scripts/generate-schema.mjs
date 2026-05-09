/**
 * Generates docs-site/static/schema.json (introspection) and
 * docs-site/static/schema.graphql (SDL) from the compiled TypeScript typedefs.
 *
 * Prerequisites:
 *   npm run build   (from the repo root — compiles src/ → dist/)
 *
 * Usage:
 *   node docs-site/scripts/generate-schema.mjs
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { introspectionFromSchema, printSchema } from 'graphql';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

// Import only the merged typedefs — no resolver deps (DuckDB, Redis, etc.)
// pathToFileURL is required on Windows: dynamic import() only accepts file:// URLs, not raw paths.
const typedefsUrl = pathToFileURL(join(rootDir, 'dist', 'schema', 'typedefs', 'index.js'));
const { typeDefs } = await import(typedefsUrl.href);

// makeExecutableSchema and introspectionFromSchema must share the same `graphql`
// instance, otherwise schema objects are rejected as "from another module or realm".
// Using static ESM imports lets Node resolve and dedupe `graphql` from a single
// starting point (this script's location → docs-site/node_modules/graphql).
const schema = makeExecutableSchema({ typeDefs });
const introspection = introspectionFromSchema(schema);
const sdl = printSchema(schema);

const outputDir = join(__dirname, '..', 'static');
mkdirSync(outputDir, { recursive: true });

const jsonPath = join(outputDir, 'schema.json');
writeFileSync(jsonPath, JSON.stringify({ data: introspection }, null, 2));

const sdlPath = join(outputDir, 'schema.graphql');
writeFileSync(sdlPath, sdl);

console.log(`Schema introspection written to ${jsonPath}`);
console.log(`Schema SDL written to ${sdlPath}`);
