import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
import { query } from './db.js';
import { ImapManager } from './imapManager.js';

// The row for a message sent with files had no paperclip, so the list showed none and
// has:attachment did not find it. Uses only connection-local temporary tables in an explicitly
// supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Sent row paperclip (upsertSentMessageRecord)', () => {
  let database;
  const account = { id: '22222222-2222-4222-8222-222222222222', email_address: 'me@example.com' };
  const upsert = (uid, meta) => ImapManager.prototype.upsertSentMessageRecord.call({}, account, 'Sent', uid, {
    messageId: `<m${uid}@example.com>`, subject: 'Hello', fromName: 'Me', fromEmail: 'me@example.com',
    to: [{ name: 'To', email: 'to@example.com' }], ...meta,
  });
  // The row a sync writes when it reaches the Sent copy first, with the paperclip it read from the
  // copy's structure.
  const synced = (uid, hasAttachments) => database.query(
    `INSERT INTO messages (account_id, uid, folder, message_id, subject, has_attachments)
     VALUES ($1, $2, 'Sent', $3, 'Hello', $4)`, [account.id, uid, `<m${uid}@example.com>`, hasAttachments]);
  const paperclipOf = async uid => (await database.query('SELECT has_attachments FROM messages WHERE uid = $1', [uid])).rows[0].has_attachments;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE messages (id serial, account_id uuid, uid bigint, folder text,
      message_id text, subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
      bcc_addresses jsonb, date timestamptz, snippet text, is_read boolean, is_starred boolean,
      has_attachments boolean DEFAULT false, flags jsonb, thread_id text, thread_key text, in_reply_to text,
      thread_references text, normalized_subject text, is_deleted boolean DEFAULT false,
      UNIQUE (account_id, uid, folder))`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => { await database.query('TRUNCATE messages'); });

  it('stores the paperclip of a message sent with files', async () => {
    await upsert(1, { hasAttachments: true });
    expect(await paperclipOf(1)).toBe(true);
  });

  it('stores none for a message sent without', async () => {
    await upsert(2, {});
    expect(await paperclipOf(2)).toBe(false);
  });

  it('keeps the paperclip of a row a sync wrote first', async () => {
    await synced(3, true);
    await upsert(3, { hasAttachments: false });
    expect(await paperclipOf(3)).toBe(true);
  });

  it('adds the paperclip to a row stored without one', async () => {
    await synced(4, false);
    await upsert(4, { hasAttachments: true });
    expect(await paperclipOf(4)).toBe(true);
  });
});
