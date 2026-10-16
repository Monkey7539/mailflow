// Mutation 1: the Trash mark is never set. trashMessageSql still parses and still runs, but every
// copy comes back in_trash = false, as if the thread route did not mark anything.
// Expected: src/routes/mail.threadTrash.postgres.test.js FAILS (INBOX.Trash, Papierkorb, Deleted,
// [Gmail]/Trash, Corbeille and the fallback Trash folders are expected true).
// Run from backend/: node ../.github/ci-scratch/mutate-always-false.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/utils/mailUtils.js';
const source = readFileSync(file, 'utf8');
const target = "export const trashMessageSql = (m = 'm') => `EXISTS (";
const count = source.split(target).length - 1;
if (count !== 1) {
  console.error(`mutate-always-false: expected the trashMessageSql definition once in ${file}, found ${count}`);
  process.exit(1);
}
writeFileSync(file, source.replace(target, "export const trashMessageSql = (m = 'm') => `false AND EXISTS ("));
console.log('mutate-always-false: trashMessageSql now reads `false AND EXISTS (...)`');
