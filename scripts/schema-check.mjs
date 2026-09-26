/**
 * Fails when the tracked `schema.graphql` is not up to date with `src/`.
 * Run after `npm run schema:generate` (see the `schema:check` npm script): the
 * regenerated file must equal the committed one.
 */

import { spawnSync } from 'node:child_process';

const FILE = 'schema.graphql';
const HINT = 'Le SDL est périmé : lancer npm run schema:generate et commiter.';

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });

// `git diff` ignores untracked files: a never-committed schema.graphql must not pass.
if (git('ls-files', '--error-unmatch', FILE).status !== 0) {
  console.error(`${FILE} n'est pas suivi par git. ${HINT}`);
  process.exit(1);
}

const diff = git('diff', '--exit-code', '--', FILE);
if (diff.status !== 0) {
  process.stdout.write(diff.stdout);
  console.error(HINT);
  process.exit(1);
}

console.log(`${FILE} est à jour.`);
