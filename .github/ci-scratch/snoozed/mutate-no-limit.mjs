// No LIMIT 1: a copy with two snooze records makes the scalar subquery return two rows.
// Expected: mail.threadSnoozed.postgres.test.js fails (the route answers 500 for that thread).
import { mutate } from './mutate.mjs';

mutate('no-limit', /LIMIT 1\) AS snoozed_folder/, ') AS snoozed_folder');
