/**
 * Generates the documentation artifacts docs-site/static/schema.graphql (SDL) and
 * docs-site/static/schema.json (introspection) from the tracked SDL at the repository
 * root (schema.graphql). Both outputs are gitignored build artifacts, read by
 * @graphql-markdown/docusaurus and by GraphQL Voyager.
 *
 * The root schema.graphql is itself generated from src/ by `npm run schema:generate`
 * (the `docs:schema` npm script runs it first), so this script no longer depends on
 * a fresh `dist/`.
 *
 * Usage:
 *   npm run docs:schema
 */

import { buildSchema, introspectionFromSchema } from 'graphql';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

const sdlSource = join(rootDir, 'schema.graphql');
const sdl = readFileSync(sdlSource, 'utf8');

// buildSchema and introspectionFromSchema share the single static `graphql` import above.
const introspection = introspectionFromSchema(buildSchema(sdl));

const outputDir = join(__dirname, '..', 'static');
mkdirSync(outputDir, { recursive: true });

const jsonPath = join(outputDir, 'schema.json');
writeFileSync(jsonPath, JSON.stringify({ data: introspection }, null, 2));

const sdlPath = join(outputDir, 'schema.graphql');
copyFileSync(sdlSource, sdlPath);

console.log(`Schema introspection written to ${jsonPath}`);
console.log(`Schema SDL copied to ${sdlPath}`);
