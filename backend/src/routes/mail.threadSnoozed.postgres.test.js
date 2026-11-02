import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
import express from 'express';
import { query } from '../services/db.js';
import mailRoutes from './mail.js';

// The thread route gives each copy the folder its own snooze record names, where that is the folder
// the copy is in, as the Snoozed view lists snoozed mail (services/messageService.js). On a server
// that keeps snoozed mail in INBOX.Snoozed, that is how the client knows a copy is snoozed. Uses only
// connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('thread route snoozed_folder PostgreSQL', () => {
  let database, server, base;
  const plain = '33333333-3333-4333-8333-333333333333';
  const prefixed = '44444444-4444-4444-8444-444444444444';
  const labels = { [plain]: 'plain', [prefixed]: 'prefixed' };
  let nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text,
        folder_mappings jsonb NOT NULL DEFAULT '{}');
      CREATE TEMP TABLE folders (account_id uuid, path text NOT NULL, name text NOT NULL,
        delimiter text, special_use text, no_select boolean NOT NULL DEFAULT false,
        UNIQUE (account_id, path));
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        uid bigint, message_id text, in_reply_to text, thread_references text,
        thread_id text, thread_key text, date timestamptz, is_deleted boolean DEFAULT false,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        reply_to jsonb, snippet text, is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text,
        list_unsubscribe_post text, delivery_addresses jsonb, flags jsonb, unsubscribed_at timestamptz);
      CREATE TEMP TABLE snoozed_messages (account_id uuid, message_id_header text,
        original_folder text, snoozed_folder text, snooze_until timestamptz)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders, email_accounts, snoozed_messages');
  });

  const account = (accountId, label) => database.query(
    `INSERT INTO email_accounts(id,user_id,enabled,include_in_unified_inbox,name,email_address,color)
     VALUES ($1,'owner',true,true,$2,$3,'#123456')`,
    [accountId, label, `${label}@example.com`],
  );
  const folder = (accountId, path) => database.query(
    'INSERT INTO folders(account_id,path,name,delimiter) VALUES ($1,$2,$3,$4)',
    [accountId, path, path.split(path.includes('.') ? '.' : '/').pop(), path.includes('.') ? '.' : '/'],
  );
  // A copy of the one conversation.
  const message = (accountId, path, messageId) => database.query(
    `INSERT INTO messages(id,account_id,folder,uid,message_id,thread_id,thread_key,date,subject)
     VALUES ($1,$2,$3,$4,$5,'<root@ext>','<root@ext>','2026-10-01T10:00Z','Plans')`,
    [id(), accountId, path, nextId, messageId],
  );
  const snooze = (accountId, messageId, path, until = '2026-10-20T08:00Z') => database.query(
    `INSERT INTO snoozed_messages(account_id,message_id_header,original_folder,snoozed_folder,snooze_until)
     VALUES ($1,$2,'INBOX',$3,$4)`,
    [accountId, messageId, path, until],
  );

  it('gives each copy the folder its own snooze record names, and each copy once', async () => {
    await account(prefixed, 'prefixed');
    await account(plain, 'plain');
    for (const path of ['INBOX', 'INBOX.Snoozed', 'INBOX.Sent']) await folder(prefixed, path);
    for (const path of ['INBOX', 'Snoozed', 'INBOX.Snoozed']) await folder(plain, path);

    // Snoozed into INBOX.Snoozed, as a server with an INBOX. prefix keeps it.
    await message(prefixed, 'INBOX.Snoozed', '<snoozed@ext>');
    await snooze(prefixed, '<snoozed@ext>', 'INBOX.Snoozed');
    // Two records name its folder: still one row, not an error from the subquery.
    await message(prefixed, 'INBOX.Snoozed', '<twice@ext>');
    await snooze(prefixed, '<twice@ext>', 'INBOX.Snoozed', '2026-10-18T08:00Z');
    await snooze(prefixed, '<twice@ext>', 'INBOX.Snoozed', '2026-10-21T08:00Z');
    // Filed there by hand, with no snooze of its own.
    await message(prefixed, 'INBOX.Snoozed', '<filed@ext>');
    // Moved back out by hand: its record is left behind until the wake-up sweep removes it.
    await message(prefixed, 'INBOX', '<moved-out@ext>');
    await snooze(prefixed, '<moved-out@ext>', 'INBOX.Snoozed');
    await message(prefixed, 'INBOX.Sent', '<reply@ext>');
    // Snoozed into the folder named Snoozed.
    await message(plain, 'Snoozed', '<plain-snoozed@ext>');
    await snooze(plain, '<plain-snoozed@ext>', 'Snoozed');
    // The same email delivered to this account too, filed in its own INBOX.Snoozed: the other
    // account's record is not this copy's.
    await message(plain, 'INBOX.Snoozed', '<snoozed@ext>');

    const response = await fetch(`${base}/api/mail/thread?id=${encodeURIComponent('<root@ext>')}`);
    expect(response.status).toBe(200);
    const { messages } = await response.json();
    expect(messages).toHaveLength(7);
    expect(Object.fromEntries(messages.map(m => [`${labels[m.account_id]} ${m.message_id} ${m.folder}`, m.snoozed_folder]))).toEqual({
      'prefixed <snoozed@ext> INBOX.Snoozed': 'INBOX.Snoozed',
      'prefixed <twice@ext> INBOX.Snoozed': 'INBOX.Snoozed',
      'prefixed <filed@ext> INBOX.Snoozed': null,
      'prefixed <moved-out@ext> INBOX': null,
      'prefixed <reply@ext> INBOX.Sent': null,
      'plain <plain-snoozed@ext> Snoozed': 'Snoozed',
      'plain <snoozed@ext> INBOX.Snoozed': null,
    });
  });
});
