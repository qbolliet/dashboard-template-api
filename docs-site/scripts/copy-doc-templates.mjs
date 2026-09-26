/**
 * Copies the curated landing-page templates into the regenerated documentation
 * directories so they are not lost when TypeDoc / @graphql-markdown wipe their
 * output dirs on each build.
 *
 *   toolbox site:
 *     docs-site/templates/code-reference-index.md  → docs-site/toolbox/code-reference/index.md
 *   API & data site:
 *     docs-site/templates/graphql-api-index.md     → docs-site/api/graphql-api/index.md
 *     docs-site/templates/data-dictionary-index.md → docs-site/api/data-dictionary/index.md
 *       (only when missing: the data dictionary generator writes its own index and keeps
 *        the previous pages when the API is unreachable, so it must never be overwritten)
 *
 * Usage: node docs-site/scripts/copy-doc-templates.mjs <toolbox|api>
 * Run after `docs:typedoc` (toolbox) or `docs:graphql` (api), see the root package.json.
 */

import { copyFile, mkdir, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const docsSite = join(here, '..');

// Gabarits par site ; `overwrite: false` conserve un fichier déjà généré
const TEMPLATES = {
  toolbox: [
    { src: 'templates/code-reference-index.md', dst: 'toolbox/code-reference/index.md', overwrite: true },
  ],
  api: [
    { src: 'templates/graphql-api-index.md', dst: 'api/graphql-api/index.md', overwrite: true },
    { src: 'templates/data-dictionary-index.md', dst: 'api/data-dictionary/index.md', overwrite: false },
  ],
};

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const site = process.argv[2];
if (!(site in TEMPLATES)) {
  console.error(`Usage: node copy-doc-templates.mjs <${Object.keys(TEMPLATES).join('|')}>`);
  process.exit(1);
}

for (const { src, dst, overwrite } of TEMPLATES[site]) {
  const dstPath = join(docsSite, dst);
  if (!overwrite && (await exists(dstPath))) {
    console.log(`[copy-doc-templates] ${dst} already present, kept`);
    continue;
  }
  await mkdir(dirname(dstPath), { recursive: true });
  await copyFile(join(docsSite, src), dstPath);
  console.log(`[copy-doc-templates] ${src} → ${dst}`);
}
