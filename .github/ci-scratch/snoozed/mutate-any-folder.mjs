// The message's snooze record counts wherever the copy now is.
// Expected: mail.threadSnoozed.postgres.test.js fails on the copy moved back to INBOX with a stale record.
import { mutate } from './mutate.mjs';

mutate('any-folder', /\s*AND sm\.snoozed_folder = m\.folder(\s*LIMIT 1\) AS snoozed_folder)/, '$1');
