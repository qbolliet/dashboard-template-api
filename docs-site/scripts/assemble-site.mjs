/**
 * Assembles the two static builds into the single GitHub Pages artifact:
 *
 *   docs-site/build/api      → docs-site/build/site/            ("API & Data", project root)
 *   docs-site/build/toolbox  → docs-site/build/site/toolbox/    ("Toolbox")
 *
 * GitHub Pages serves one artifact per repository; the two Docusaurus sites are built
 * separately (their baseUrl already carries the final path, see site-shared.ts) and
 * only merged here. Run after `docs:build:toolbox` and `docs:build:api`.
 *
 * Usage: node docs-site/scripts/assemble-site.mjs
 */

import { cp, rm, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, '..', 'build');

const apiBuild = join(buildDir, 'api');
const toolboxBuild = join(buildDir, 'toolbox');
const siteDir = join(buildDir, 'site');

for (const dir of [apiBuild, toolboxBuild]) {
  try {
    await stat(dir);
  } catch {
    console.error(`[assemble-site] ${dir} is missing: run npm run docs:build:toolbox and docs:build:api first.`);
    process.exit(1);
  }
}

await rm(siteDir, { recursive: true, force: true });
await cp(apiBuild, siteDir, { recursive: true });
await cp(toolboxBuild, join(siteDir, 'toolbox'), { recursive: true });

console.log(`[assemble-site] build/api → build/site/, build/toolbox → build/site/toolbox/`);
