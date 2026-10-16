// Any snooze record naming the copy's folder counts, whatever message it is for.
// Expected: mail.threadSnoozed.postgres.test.js fails on the copy filed into INBOX.Snoozed by hand.
import { mutate } from './mutate.mjs';

mutate('any-message', /WHERE sm\.account_id = m\.account_id AND sm\.message_id_header = m\.message_id/, 'WHERE sm.account_id = m.account_id');
