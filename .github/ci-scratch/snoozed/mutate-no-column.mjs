// The thread route returns no snoozed_folder at all, as before the integration commit.
// Expected: mail.threadSnoozed.postgres.test.js fails, every snoozed_folder undefined.
import { mutate } from './mutate.mjs';

mutate('no-column', /\(SELECT sm\.snoozed_folder FROM snoozed_messages sm[\s\S]*?LIMIT 1\) AS snoozed_folder,\s*/, '');
