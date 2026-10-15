// Mutation 5: the trash mapping is read from every account, not from the copy's own account.
// Expected: src/routes/mail.threadTrash.postgres.test.js FAILS on the "missing" account: its plain
// folder "Corbeille" matches the "mapped" account's mapping, so its Corbeille comes back true and
// its Trash false, where bulk-delete expunges from its Trash only.
// Run from backend/: node ../.github/ci-scratch/mutate-drop-mapping-join.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/utils/mailUtils.js';
const source = readFileSync(file, 'utf8');
const target = 'FROM folders uf JOIN email_accounts ea ON ea.id = uf.account_id';
const count = source.split(target).length - 1;
if (count !== 1) {
  console.error(`mutate-drop-mapping-join: expected the mapping join once in ${file}, found ${count}`);
  process.exit(1);
}
writeFileSync(file, source.replace(target, 'FROM folders uf CROSS JOIN email_accounts ea'));
console.log("mutate-drop-mapping-join: trashMessageSql now matches any account's trash mapping");
