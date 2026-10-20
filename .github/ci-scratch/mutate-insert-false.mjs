// Mutation 3: upsertSentMessageRecord passes false for has_attachments whatever it was given, as
// the INSERT did before the fix. The statement is unchanged, so it still runs.
// Expected: src/services/imapManager.sentAttachments.postgres.test.js FAILS
// ("stores the paperclip of a message sent with files", "adds the paperclip to a row stored
// without one").
// Run from backend/: node ../.github/ci-scratch/mutate-insert-false.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/imapManager.js';
const source = readFileSync(file, 'utf8');
// upsertDraftMessageRecord ends its parameters with Boolean(hasAttachments) too; the Bcc line
// before it marks upsertSentMessageRecord's.
const target = /(Array\.isArray\(bcc\) && bcc\.length \? JSON\.stringify\(bcc\) : null,\r?\n[^\S\r\n]*)Boolean\(hasAttachments\),/g;
const count = (source.match(target) || []).length;
if (count !== 1) {
  console.error(`mutate-insert-false: expected the Sent upsert's parameter once in ${file}, found ${count}`);
  process.exit(1);
}
writeFileSync(file, source.replace(target, '$1false,'));
console.log('mutate-insert-false: upsertSentMessageRecord now passes false for has_attachments');
