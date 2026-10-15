// Mutation 4: the copy's folder row is no longer looked up in its own account, so a folder with the
// same path in another account can mark it.
// Expected: src/routes/mail.threadTrash.postgres.test.js FAILS on "missing Papierkorb", a plain
// folder of the "missing" account that the "localized" account's \Trash-flagged Papierkorb marks.
// Run from backend/: node ../.github/ci-scratch/mutate-drop-folder-account.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/utils/mailUtils.js';
const source = readFileSync(file, 'utf8');
const target = 'WHERE tf.account_id = ${m}.account_id AND tf.path = ${m}.folder';
const count = source.split(target).length - 1;
if (count !== 1) {
  console.error(`mutate-drop-folder-account: expected the folder lookup once in ${file}, found ${count}`);
  process.exit(1);
}
writeFileSync(file, source.replace(target, 'WHERE tf.path = ${m}.folder'));
console.log('mutate-drop-folder-account: trashMessageSql no longer scopes the folder row to the account');
