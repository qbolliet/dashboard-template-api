/**
 * Generates docs-site/static/schema.json from the compiled TypeScript typedefs.
 *
 * Prerequisites:
 *   npm run build   (from the repo root — compiles src/ → dist/)
 *
 * Usage:
 *   node docs-site/scripts/generate-schema.mjs
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

// Import only the merged typedefs — no resolver deps (DuckDB, Redis, etc.)
// pathToFileURL is required on Windows: dynamic import() only accepts file:// URLs, not raw paths.
const typedefsUrl = pathToFileURL(join(rootDir, 'dist', 'schema', 'typedefs', 'index.js'));
const { typeDefs } = await import(typedefsUrl.href);

// Import introspectionFromSchema from the ROOT node_modules to avoid the dual-graphql
// conflict on Windows: docs-site/node_modules/graphql (voyager dep) vs root node_modules/graphql.
const rootGraphqlUrl = pathToFileURL(join(rootDir, 'node_modules', 'graphql', 'index.js'));
const { introspectionFromSchema } = await import(rootGraphqlUrl.href);

const schema = makeExecutableSchema({ typeDefs });
const introspection = introspectionFromSchema(schema);

const outputDir = join(__dirname, '..', 'static');
mkdirSync(outputDir, { recursive: true });

const outputPath = join(outputDir, 'schema.json');
writeFileSync(outputPath, JSON.stringify({ data: introspection }, null, 2));

console.log(`Schema introspection written to ${outputPath}`);
