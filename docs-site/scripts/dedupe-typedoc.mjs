/**
 * Post-processes the typedoc-plugin-markdown output:
 *
 *   1. Resolves "-1" name collisions (e.g. cache/redis-1.md vs cache/redis.md):
 *      - if the canonical file already exists, the duplicate is deleted (the
 *        member is already documented in the parent module summary);
 *      - otherwise the suffixed file is renamed to its canonical name.
 *      Links pointing at the suffixed name are rewritten across the tree.
 *
 *   2. Strips the TypeDoc breadcrumb header at the top of every generated file.
 *      Docusaurus already provides breadcrumbs through the sidebar, and the
 *      TypeDoc breadcrumb links to a `README.md` route that does not exist
 *      (the landing page is `index.md`, copied from the templates folder).
 *
 *   3. Deletes the TypeDoc-generated README.md so it does not conflict with
 *      the curated index.md copied later from docs-site/templates/.
 *
 * Usage: node docs-site/scripts/dedupe-typedoc.mjs
 */

import { readdir, readFile, rename, writeFile, stat, unlink } from 'fs/promises';
import { join, dirname, relative, sep, posix } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', 'code-reference');

const BREADCRUMB_RE =
  /^\[\*\*[^\]]+\*\*\]\([^)]*README\.md\)\s*\n\s*\n\*\*\*\s*\n\s*\n\[[^\]]+\]\([^)]*README\.md\)[^\n]*\n\s*\n/;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const files = await walk(ROOT);
  const linkUpdates = [];

  for (const file of files) {
    if (!file.endsWith('-1.md')) continue;
    const canonical = file.replace(/-1\.md$/, '.md');
    if (await exists(canonical)) {
      await unlink(file);
      console.log(`[dedupe-typedoc] deleted duplicate ${relative(ROOT, file)} (canonical exists)`);
    } else {
      await rename(file, canonical);
      console.log(`[dedupe-typedoc] renamed ${relative(ROOT, file)} → ${relative(ROOT, canonical)}`);
    }
    linkUpdates.push({ from: file, to: canonical });
  }

  const allFiles = await walk(ROOT);

  for (const file of allFiles) {
    if (!file.endsWith('.md')) continue;
    const original = await readFile(file, 'utf8');
    let updated = original.replace(BREADCRUMB_RE, '');

    for (const { from, to } of linkUpdates) {
      const oldRel = relative(dirname(file), from).split(sep).join(posix.sep);
      const newRel = relative(dirname(file), to).split(sep).join(posix.sep);
      if (!oldRel) continue;
      updated = updated.split(oldRel).join(newRel);
    }

    if (updated !== original) {
      await writeFile(file, updated);
    }
  }

  const typedocReadme = join(ROOT, 'README.md');
  if (await exists(typedocReadme)) {
    await unlink(typedocReadme);
    console.log('[dedupe-typedoc] removed TypeDoc-generated README.md');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
