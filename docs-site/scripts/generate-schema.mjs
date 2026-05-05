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
import { introspectionFromSchema } from 'graphql';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

// Import only the merged typedefs — no resolver deps (DuckDB, Redis, etc.)
const { typeDefs } = await import(
  join(rootDir, 'dist', 'schema', 'typedefs', 'index.js')
);

const schema = makeExecutableSchema({ typeDefs });
const introspection = introspectionFromSchema(schema);

const outputDir = join(__dirname, '..', 'static');
mkdirSync(outputDir, { recursive: true });

const outputPath = join(outputDir, 'schema.json');
writeFileSync(outputPath, JSON.stringify({ data: introspection }, null, 2));

console.log(`Schema introspection written to ${outputPath}`);
