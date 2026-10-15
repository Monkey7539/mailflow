// Mutation 3: a trash mapping counts as usable even when its folder cannot be selected, unlike
// mappedFolderUsable, which bulk-delete's resolveAllTrashPaths goes through.
// Expected: src/routes/mail.threadTrash.postgres.test.js FAILS on the "noselect" account: its
// mapping names the \Noselect "[Gmail]" parent, so bulk-delete falls back to the Trash rules and
// expunges from "[Gmail]/Trash", but the mutated mark follows the mapping and comes back false.
// Run from backend/: node ../.github/ci-scratch/mutate-noselect-mapping.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/utils/mailUtils.js';
const source = readFileSync(file, 'utf8');
const target = " AND uf.no_select = false";
const count = source.split(target).length - 1;
if (count !== 1) {
  console.error(`mutate-noselect-mapping: expected the no_select test once in ${file}, found ${count}`);
  process.exit(1);
}
writeFileSync(file, source.replace(target, ''));
console.log('mutate-noselect-mapping: trashMessageSql no longer requires a selectable mapped folder');
