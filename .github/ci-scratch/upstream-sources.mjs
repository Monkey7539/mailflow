// Not a mutation: puts back 1903651d's imapManager.js, the upsert before the fix (the PostgreSQL
// test does not load send.js).
// Expected: src/services/imapManager.sentAttachments.postgres.test.js FAILS ("stores the
// paperclip of a message sent with files", "adds the paperclip to a row stored without one"),
// since that upsertSentMessageRecord always stores false and never updates the flag.
// It only means something where every other backend source file is still 1903651d's.
// Run from backend/: node ../.github/ci-scratch/upstream-sources.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const base = '1903651d9463dd6140ea2966c68865f0106f1269';
const restore = ['src/services/imapManager.js'];
const fixFiles = [...restore, 'src/routes/send.js'];
const others = spawnSync('git', ['diff', '--quiet', base, 'HEAD', '--', 'src',
  ...fixFiles.map(file => `:(exclude)${file}`), ':(exclude)*.test.js'], { encoding: 'utf8' });
if (others.status !== 0) {
  console.error(`upstream-sources: backend/src differs from ${base.slice(0, 8)} beyond the fix (or git diff failed): ${others.stderr || others.status}`);
  process.exit(1);
}
for (const file of restore) {
  writeFileSync(file, execFileSync('git', ['show', `${base}:backend/${file}`]));
  console.log(`upstream-sources: ${file} is now ${base.slice(0, 8)}'s`);
}
