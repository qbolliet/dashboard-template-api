/**
 * Post-processes the typedoc-plugin-markdown output to remove "-1" suffixed
 * file names (e.g. cache/redis-1.md → cache/redis.md) caused by name
 * collisions between a parent module's exported member and a child sub-module.
 *
 * Renames each *-1.md file to its canonical name (when free) and rewrites
 * every Markdown link referencing the suffixed name across the output tree.
 *
 * Also injects Docusaurus frontmatter into the TypeDoc-generated README.md
 * so it appears as "Overview" in the sidebar at position 1.
 *
 * Usage: node docs-site/scripts/dedupe-typedoc.mjs
 */

import { readdir, readFile, rename, writeFile, stat } from 'fs/promises';
import { join, dirname, relative, sep, posix } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', 'code-reference');

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

async function main() {
  const files = await walk(ROOT);
  const renames = [];

  for (const file of files) {
    if (!file.endsWith('-1.md')) continue;
    const canonical = file.replace(/-1\.md$/, '.md');
    try {
      await stat(canonical);
      console.warn(`[dedupe-typedoc] skip ${file}: ${canonical} already exists`);
      continue;
    } catch {
      // canonical doesn't exist — safe to rename
    }
    await rename(file, canonical);
    renames.push({ from: file, to: canonical });
    console.log(`[dedupe-typedoc] renamed ${relative(ROOT, file)} → ${relative(ROOT, canonical)}`);
  }

  if (renames.length === 0) {
    console.log('[dedupe-typedoc] no -1 files found, nothing to do.');
    return;
  }

  // Rewrite links referencing renamed files across the output tree.
  const allFiles = await walk(ROOT);
  for (const file of allFiles) {
    if (!file.endsWith('.md')) continue;
    const original = await readFile(file, 'utf8');
    let updated = original;
    for (const { from, to } of renames) {
      const oldRel = relative(dirname(file), from).split(sep).join(posix.sep);
      const newRel = relative(dirname(file), to).split(sep).join(posix.sep);
      if (!oldRel) continue;
      updated = updated.split(oldRel).join(newRel);
    }
    if (updated !== original) {
      await writeFile(file, updated);
      console.log(`[dedupe-typedoc] updated links in ${relative(ROOT, file)}`);
    }
  }
}

async function addReadmeFrontmatter() {
  const readmePath = join(ROOT, 'README.md');
  try {
    const content = await readFile(readmePath, 'utf8');
    if (content.startsWith('---')) return;
    await writeFile(
      readmePath,
      `---\nsidebar_label: Overview\nsidebar_position: 1\n---\n\n${content}`
    );
    console.log('[dedupe-typedoc] added frontmatter to README.md');
  } catch {
    // README.md may not exist on first run
  }
}

main()
  .then(addReadmeFrontmatter)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
