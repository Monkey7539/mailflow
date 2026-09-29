import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    ensureFolder: vi.fn(), moveMessage: vi.fn(), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(),
    broadcast: vi.fn(), scheduleCountRefresh: vi.fn(),
  },
}));

import express from 'express';
import mailRoutes, { gatherSnoozeConversation } from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

// Column subset that the pool query selects.
function row(id, message_id, { in_reply_to = null, thread_references = null, folder = 'INBOX', is_read = true } = {}) {
  return { id, uid: id.charCodeAt(0), account_id: 'acct', folder, message_id, in_reply_to, thread_references, is_read };
}
const ids = (rows) => rows.map(r => r.message_id).sort();

const A = row('A', '<a>');                                              // root, in inbox
const B = row('B', '<b>', { in_reply_to: '<a>', thread_references: '<a>' });
const C = row('C', '<c>', { in_reply_to: '<b>', thread_references: '<a> <b>' });
// Unrelated messages sharing thread_id only through subject collision (no header links).
const X = row('X', '<x>');
const Y = row('Y', '<y>');

const msgOf = (r) => ({ ...r, thread_id: 't' });

// gatherSnoozeConversation issues: (1) the thread pool query, (2) the already-snoozed lookup.
function mockPool(rows, alreadySnoozed = []) {
  query.mockResolvedValueOnce({ rows });
  query.mockResolvedValueOnce({ rows: alreadySnoozed.map(m => ({ message_id_header: m })) });
}

describe('gatherSnoozeConversation', () => {
  beforeEach(() => query.mockReset());

  it('returns only the message when it has no thread_id (and never queries)', async () => {
    const out = await gatherSnoozeConversation({ ...A, thread_id: null });
    expect(ids(out)).toEqual(['<a>']);
    expect(query).not.toHaveBeenCalled();
  });

  it('snoozes the full reply chain when messages are header-linked', async () => {
    mockPool([A, B, C]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<b>', '<c>']);
  });

  it('returns the acted-on message first (fatal-on-self before touching siblings)', async () => {
    mockPool([B, C, A]); // acted-on message A last in pool order
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(out[0].message_id).toBe('<a>');
  });

  it('does NOT sweep in subject-collision siblings that share no header link', async () => {
    mockPool([A, X, Y]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>']);
  });

  it('selects only the real conversation from a mixed pool', async () => {
    mockPool([A, B, X, Y]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<b>']);
  });

  it('reaches the root when acting on a reply (undirected walk)', async () => {
    mockPool([A, B, C]);
    const out = await gatherSnoozeConversation(msgOf(C));
    expect(ids(out)).toEqual(['<a>', '<b>', '<c>']);
  });

  it('uses out-of-folder messages as connectors but snoozes only the source folder', async () => {
    // The link between the two inbox messages runs through a Sent-folder reply.
    const sent = row('S', '<s>', { in_reply_to: '<a>', thread_references: '<a>', folder: 'Sent' });
    const inboxReply = row('R', '<r>', { in_reply_to: '<s>', thread_references: '<a> <s>' });
    mockPool([A, sent, inboxReply]);
    const out = await gatherSnoozeConversation(msgOf(A));
    // A (inbox) and R (inbox) are one conversation via the Sent connector; Sent copy is not snoozed.
    expect(ids(out)).toEqual(['<a>', '<r>']);
  });

  it('excludes members already snoozed', async () => {
    mockPool([A, B, C], ['<b>']);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<c>']);
  });

  it('dedupes by Message-ID so a doubled source row is snoozed once', async () => {
    const Adup = row('A2', '<a>'); // same Message-ID, different row id, same folder
    mockPool([A, Adup, B]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<b>']);
    expect(out.filter(r => r.message_id === '<a>')).toHaveLength(1);
  });

  it('includes the triggering message even if the pool query misses it', async () => {
    // Transient read skew: pool omits A, but B references it.
    mockPool([B]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<b>']);
  });
});

const ACCOUNT_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const MSG_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const ACCOUNT = { id: ACCOUNT_ID, user_id: 'user-1' };

// `message` is the acted-on messages row and `snoozes` the snoozed_messages table. The fake
// applies the route's writes to them, so the tests pin the stored state rather than SQL text.
let message, snoozes;

function fakeQuery(rawSql, params = []) {
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  const result = (rows) => Promise.resolve({ rows, rowCount: rows.length });
  if (sql.includes('FROM messages m JOIN email_accounts a')) {
    return result(params[0] === message.id ? [{ ...message, user_id: 'user-1' }] : []);
  }
  if (sql.startsWith('SELECT id FROM snoozed_messages')) {
    return result(snoozes.filter(s => s.account_id === params[0] && s.message_id_header === params[1]));
  }
  if (sql.startsWith('SELECT * FROM email_accounts')) return result([ACCOUNT]);
  const update = sql.match(/^UPDATE messages SET (.+) WHERE id = \$(\d+)$/);
  if (update && params[Number(update[2]) - 1] === message.id) {
    for (const assignment of update[1].split(',')) {
      const [col, value] = assignment.split('=').map(s => s.trim());
      message[col] = params[Number(value.slice(1)) - 1];
    }
    return result([]);
  }
  const insert = sql.match(/^INSERT INTO snoozed_messages \((.+?)\) VALUES/);
  if (insert) {
    snoozes.push(Object.fromEntries(insert[1].split(',').map((col, i) => [col.trim(), params[i]])));
    return result([]);
  }
  return result([]);
}

// adjustFolderCounts is fire-and-forget; its params are [totalDelta, unreadDelta, accountId, path].
const countedPaths = () => query.mock.calls
  .filter(([sql]) => sql.includes('UPDATE folders f'))
  .map(([, p]) => p[3]);

// On a server with an INBOX. personal-namespace prefix, imapflow creates (or finds) the folder
// at INBOX.Snoozed, and the folder sync files everything in it under that path. Elsewhere it is
// plain Snoozed.
describe('POST /api/mail/messages/:id/snooze — Snoozed folder path', () => {
  let srv, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise(r => { srv = app.listen(0, r); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterAll(async () => { await new Promise(r => srv.close(r)); });
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(fakeQuery);
    for (const fn of Object.values(imapManager)) fn.mockReset();
    message = { id: MSG_ID, account_id: ACCOUNT_ID, uid: 42, folder: 'INBOX', is_read: false, message_id: '<a@example.com>', thread_id: null };
    snoozes = [];
    imapManager.ensureFolder.mockResolvedValue({ path: 'INBOX.Snoozed', created: false });
    imapManager.moveMessage.mockResolvedValue(7);
  });

  const snooze = () => fetch(`${base}/api/mail/messages/${MSG_ID}/snooze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ until: new Date(Date.now() + 86_400_000).toISOString() }),
  });

  it.each([
    ['with an INBOX. prefix', 'INBOX.Snoozed'],
    ['without a prefix', 'Snoozed'],
  ])('stores the path the server gave the folder (%s)', async (_, path) => {
    imapManager.ensureFolder.mockResolvedValue({ path, created: false });
    expect((await snooze()).status).toBe(200);
    expect(message).toMatchObject({ folder: path, uid: 7 });
    expect(snoozes).toEqual([expect.objectContaining({
      message_id_header: '<a@example.com>', original_folder: 'INBOX', snoozed_folder: path,
    })]);
    expect(countedPaths()).toEqual(['INBOX', path]);
    expect(imapManager.moveMessage).toHaveBeenCalledWith(ACCOUNT, 42, 'INBOX', path);
    expect(imapManager.ensureFolder).toHaveBeenCalledWith(ACCOUNT, 'Snoozed', { resolvePath: true });
  });

  it('without UIDPLUS, stores, guards and later releases the stale uid under that path too', async () => {
    // Fake the clock only once the request is in the route: fetch waits on a setTimeout(0)
    // before it reuses an idle keep-alive socket, so faking it earlier stalls the request.
    imapManager.moveMessage.mockImplementation(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      return null;
    });
    try {
      expect((await snooze()).status).toBe(200);
      expect(message).toMatchObject({ folder: 'INBOX.Snoozed', uid: 42 });
      expect(snoozes).toEqual([expect.objectContaining({ snoozed_folder: 'INBOX.Snoozed' })]);
      expect(imapManager._guardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX.Snoozed', 42);
      expect(imapManager._unguardMoveUid).not.toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX.Snoozed', 42);
      vi.advanceTimersByTime(10_000);
      expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX.Snoozed', 42);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a message that is already in the Snoozed folder', async () => {
    message.folder = 'INBOX.Snoozed';
    expect((await snooze()).status).toBe(400);
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect(snoozes).toEqual([]);
  });
});
