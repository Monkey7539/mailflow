// Mutation 4: upsertSentMessageRecord passes true for has_attachments whatever it was given, so
// every sent message gets a paperclip. The statement is unchanged, so it still runs.
// Expected: src/services/imapManager.sentAttachments.postgres.test.js FAILS
// ("stores none for a message sent without").
// Run from backend/: node ../.github/ci-scratch/mutate-insert-true.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/imapManager.js';
const source = readFileSync(file, 'utf8');
// upsertDraftMessageRecord ends its parameters with Boolean(hasAttachments) too; the Bcc line
// before it marks upsertSentMessageRecord's.
const target = /(Array\.isArray\(bcc\) && bcc\.length \? JSON\.stringify\(bcc\) : null,\r?\n[^\S\r\n]*)Boolean\(hasAttachments\),/g;
const count = (source.match(target) || []).length;
if (count !== 1) {
  console.error(`mutate-insert-true: expected the Sent upsert's parameter once in ${file}, found ${count}`);
  process.exit(1);
}
writeFileSync(file, source.replace(target, '$1true,'));
console.log('mutate-insert-true: upsertSentMessageRecord now passes true for has_attachments');
