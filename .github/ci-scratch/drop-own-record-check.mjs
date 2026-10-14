// Mutation for the scratch PostgreSQL check: drop the Snoozed view's own-record EXISTS, leaving
// only "the folder is one some snooze record names". Run from backend/.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/messageService.js';
const text = readFileSync(file, 'utf8');
const clause = /\s*\+ ' AND EXISTS \(SELECT 1 FROM snoozed_messages own WHERE own\.account_id = m\.account_id'\s*\+ ' AND own\.message_id_header = m\.message_id AND own\.snoozed_folder = m\.folder\)\)';/;
if (!clause.test(text)) throw new Error('own-record clause not found');
writeFileSync(file, text.replace(clause, "\n  + ')';"));
console.log('own-record check dropped');
