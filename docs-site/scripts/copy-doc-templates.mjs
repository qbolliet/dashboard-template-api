/**
 * Copies the curated landing-page templates into the regenerated documentation
 * directories so they are not lost when TypeDoc / @graphql-markdown wipe their
 * output dirs on each build.
 *
 *   docs-site/templates/code-reference-index.md → docs-site/code-reference/index.md
 *   docs-site/templates/graphql-api-index.md    → docs-site/graphql-api/index.md
 *
 * Run after `docs:typedoc` and `docs:graphql` (see root package.json).
 */

import { copyFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const docsSite = join(here, '..');

const copies = [
  ['templates/code-reference-index.md', 'code-reference/index.md'],
  ['templates/graphql-api-index.md', 'graphql-api/index.md'],
];

for (const [src, dst] of copies) {
  const srcPath = join(docsSite, src);
  const dstPath = join(docsSite, dst);
  await mkdir(dirname(dstPath), { recursive: true });
  await copyFile(srcPath, dstPath);
  console.log(`[copy-doc-templates] ${src} → ${dst}`);
}
