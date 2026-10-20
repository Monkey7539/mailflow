// Mutation 1: the upsert's own flag replaces the stored one, so a row a sync wrote first with the
// paperclip loses it when the upsert says false.
// Expected: src/services/imapManager.sentAttachments.postgres.test.js FAILS
// ("keeps the paperclip of a row a sync wrote first").
// Run from backend/: node ../.github/ci-scratch/mutate-overwrite.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/imapManager.js';
const source = readFileSync(file, 'utf8');
const target = 'has_attachments = messages.has_attachments OR EXCLUDED.has_attachments,';
const count = source.split(target).length - 1;
if (count !== 1) {
  console.error(`mutate-overwrite: expected the paperclip update once in ${file}, found ${count}`);
  process.exit(1);
}
writeFileSync(file, source.replace(target, 'has_attachments = EXCLUDED.has_attachments,'));
console.log('mutate-overwrite: the upsert now sets has_attachments = EXCLUDED.has_attachments');
