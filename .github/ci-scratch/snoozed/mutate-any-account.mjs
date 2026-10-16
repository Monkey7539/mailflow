// A snooze record of any account counts.
// Expected: mail.threadSnoozed.postgres.test.js fails on another account's copy of the same Message-ID.
import { mutate } from './mutate.mjs';

mutate('any-account', /WHERE sm\.account_id = m\.account_id AND sm\.message_id_header = m\.message_id/, 'WHERE sm.message_id_header = m.message_id');
