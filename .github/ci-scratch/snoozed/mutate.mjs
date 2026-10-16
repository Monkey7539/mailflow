// Shared by the snoozed_folder mutations: edits src/routes/mail.js in place, once, or exits 1 without
// touching anything when the target text is not found exactly once. Run from backend/.
import { readFileSync, writeFileSync } from 'node:fs';

export function mutate(label, pattern, replacement) {
  const file = 'src/routes/mail.js';
  const text = readFileSync(file, 'utf8');
  const hits = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) || [];
  if (hits.length !== 1) {
    console.error(`${label}: expected one match in ${file}, found ${hits.length}; nothing changed`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(pattern, replacement));
  console.log(`${label}: ${JSON.stringify(hits[0])} -> ${JSON.stringify(replacement)}`);
}
