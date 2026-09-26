/**
 * Compares the tracked `schema.graphql` with the SDL of the last release and prints
 * the changes grouped by criticality (breaking / dangerous / non-breaking).
 *
 * Exit code: 1 when there is at least one breaking change, 0 otherwise — including
 * when no baseline exists yet (first release: the tag does not contain the file) —
 * and 2 on an unexpected failure.
 *
 * Usage:
 *   npm run schema:diff
 *   npm run schema:diff -- --base v0.2.0        # explicit git ref instead of the last tag
 *   npm run schema:diff -- --base-file old.graphql  # explicit SDL file as baseline
 *   npm run schema:diff -- --markdown report.md # also write a Markdown report
 */

import { Change, CriticalityLevel, diff } from '@graphql-inspector/core';
import { buildSchema } from 'graphql';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SDL_FILE = 'schema.graphql';
// release-please tags releases `vX.Y.Z`; older `dashboard-template-api-X.Y.Z` tags are ignored.
const TAG_PATTERN = 'v[0-9]*';
const MAX_MESSAGE_LENGTH = 200;

const GROUPS: { level: CriticalityLevel; title: string; icon: string }[] = [
  { level: CriticalityLevel.Breaking, title: 'Breaking changes', icon: '✖' },
  { level: CriticalityLevel.Dangerous, title: 'Dangerous changes', icon: '⚠' },
  { level: CriticalityLevel.NonBreaking, title: 'Non-breaking changes', icon: '✔' },
];

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Change messages embed whole descriptions: keep the first line, capped for readability. */
function summarize(message: string): string {
  const [firstLine] = message.split('\n');
  return firstLine.length > MAX_MESSAGE_LENGTH
    ? `${firstLine.slice(0, MAX_MESSAGE_LENGTH)}…`
    : firstLine;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Last release tag reachable from HEAD, or the explicit `--base` ref. */
function resolveBase(): string {
  const explicit = argValue('--base');
  if (explicit) return explicit;
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', TAG_PATTERN).trim();
  } catch {
    console.log('Aucun tag de release atteignable : rien à comparer.');
    process.exit(0);
  }
}

/** Returns the baseline label and SDL, or exits 0 when there is nothing to compare with. */
function loadBase(): { base: string; baseSdl: string } {
  const baseFile = argValue('--base-file');
  if (baseFile) return { base: baseFile, baseSdl: readFileSync(baseFile, 'utf8') };

  const base = resolveBase();
  try {
    return { base, baseSdl: git('show', `${base}:${SDL_FILE}`) };
  } catch {
    console.log(
      `${base} ne contient pas ${SDL_FILE} (première release avec ce contrat) : rien à comparer.`,
    );
    process.exit(0);
  }
}

async function main(): Promise<void> {
  const { base, baseSdl } = loadBase();

  const changes: Change[] = await diff(
    buildSchema(baseSdl),
    buildSchema(readFileSync(SDL_FILE, 'utf8')),
  );

  const lines: string[] = [`Schema diff: ${SDL_FILE} vs ${base}`, ''];
  const markdown: string[] = [`### GraphQL schema diff vs \`${base}\``, ''];

  if (changes.length === 0) {
    lines.push('Aucun changement de schéma.');
    markdown.push('No schema change.');
  }

  for (const { level, title, icon } of GROUPS) {
    const group = changes.filter((change) => change.criticality.level === level);
    if (group.length === 0) continue;
    // Non-breaking changes are the long tail: fold them in the Markdown report.
    const folded = level === CriticalityLevel.NonBreaking;
    lines.push(`${icon} ${title} (${group.length})`);
    markdown.push(
      folded
        ? `<details><summary>${title} (${group.length})</summary>`
        : `**${title} (${group.length})**`,
      '',
    );
    for (const change of group) {
      lines.push(`  - ${summarize(change.message)}`);
      markdown.push(`- ${summarize(change.message)}`);
    }
    lines.push('');
    markdown.push('', ...(folded ? ['</details>', ''] : []));
  }

  console.log(lines.join('\n'));

  const markdownPath = argValue('--markdown');
  if (markdownPath) writeFileSync(markdownPath, markdown.join('\n') + '\n', 'utf8');

  const breaking = changes.filter(
    (change) => change.criticality.level === CriticalityLevel.Breaking,
  );
  if (breaking.length > 0) {
    console.error(`${breaking.length} breaking change(s) par rapport à ${base}.`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
