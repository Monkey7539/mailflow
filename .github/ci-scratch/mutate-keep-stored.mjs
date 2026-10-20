// Mutation 2: the ON CONFLICT update leaves has_attachments alone, as before the fix, so a row
// stored without the paperclip never gets it.
// Expected: src/services/imapManager.sentAttachments.postgres.test.js FAILS
// ("adds the paperclip to a row stored without one").
// Run from backend/: node ../.github/ci-scratch/mutate-keep-stored.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/imapManager.js';
const source = readFileSync(file, 'utf8');
const target = /[^\S\r\n]*has_attachments = messages\.has_attachments OR EXCLUDED\.has_attachments,\r?\n/g;
const count = (source.match(target) || []).length;
if (count !== 1) {
  console.error(`mutate-keep-stored: expected the paperclip update once in ${file}, found ${count}`);
  process.exit(1);
}
writeFileSync(file, source.replace(target, ''));
console.log('mutate-keep-stored: the ON CONFLICT update no longer sets has_attachments');
