// Not a mutation: puts back c579402a's thread route and mailUtils.js, the backend before the fix.
// Expected: src/routes/mail.threadTrash.postgres.test.js FAILS on its table of expected marks, since
// that thread route sends no in_trash at all. It only means something where every other backend
// source file is still c579402a's (the fix branch itself); anywhere else it changes nothing and
// exits 3.
// Run from backend/: node ../.github/ci-scratch/upstream-sources.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const base = 'c579402a0b9e694849c7be8e56717e76c03fea7f';
const files = ['src/routes/mail.js', 'src/utils/mailUtils.js'];
const others = spawnSync('git', ['diff', '--quiet', base, 'HEAD', '--', 'src',
  ...files.map(file => `:(exclude)${file}`), ':(exclude)*.test.js'], { encoding: 'utf8' });
if (others.status === 1) {
  console.error(`upstream-sources: backend/src differs from ${base.slice(0, 8)} beyond the fix; nothing changed`);
  process.exit(3);
}
if (others.status !== 0) {
  console.error(`upstream-sources: git diff failed: ${others.stderr || others.error}`);
  process.exit(1);
}
for (const file of files) {
  writeFileSync(file, execFileSync('git', ['show', `${base}:backend/${file}`]));
  console.log(`upstream-sources: ${file} is now ${base.slice(0, 8)}'s`);
}
