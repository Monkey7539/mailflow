// Mutation 2: the trash mapping rule is dropped, so the Trash rules (special-use flag, stock names)
// decide alone, as if the account had no usable mapping.
// Expected: src/routes/mail.threadTrash.postgres.test.js FAILS on the "mapped" account: its mapped
// Trash "Corbeille" (no flag, no stock name) comes back false, and its \Trash-flagged "Trash", which
// bulk-delete moves rather than expunges while the mapping is usable, comes back true.
// Run from backend/: node ../.github/ci-scratch/mutate-drop-mapping.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/utils/mailUtils.js';
const source = readFileSync(file, 'utf8');
const pattern = /COALESCE\(tf\.path = \([\s\S]*?\), (\$\{TRASH_FOLDER_SQL\})\)/;
const match = source.match(pattern);
if (!match || !match[0].includes("folder_mappings->>'trash'")) {
  console.error(`mutate-drop-mapping: the mapping COALESCE in trashMessageSql was not found in ${file}`);
  process.exit(1);
}
writeFileSync(file, source.replace(pattern, '$1'));
console.log('mutate-drop-mapping: trashMessageSql now tests only ${TRASH_FOLDER_SQL}');
