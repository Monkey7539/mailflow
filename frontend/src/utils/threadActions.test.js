// Tests for the thread-level actions.
//
// The contract worth pinning is the one that is easy to get wrong when an action goes
// from one message to many: every message the action covers is removed and every one
// comes back, the request is held for the undo window rather than sent immediately,
// archive and delete cover only what the list behind the pane is showing, move only the
// account whose folder was picked, and spam deliberately spares the reader's own replies.
//
// Real store, real api layer, stubbed fetch and stubbed clock.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
});

let requests = [];
let failNext = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  requests.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
  if (failNext) return { ok: false, status: 500, json: async () => ({ error: 'server said no' }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

const { useStore } = await import('../store/index.js');
const { resolveThreadMessages, archiveThread, deleteThread, spamThread, moveThread, snoozeThread } = await import('./threadActions.js');

// A thread of three: two from the correspondent, one the reader sent.
const THREAD = [
  { id: 'a1', account_id: 'acct', folder: 'INBOX', subject: 'Hello', from_email: 'them@x.z', date: '2026-01-01T00:00:00Z', is_read: true },
  { id: 'a2', account_id: 'acct', folder: 'Sent', subject: 'Re: Hello', from_email: 'me@x.z', date: '2026-01-02T00:00:00Z', is_read: true },
  { id: 'a3', account_id: 'acct', folder: 'INBOX', subject: 'Re: Hello', from_email: 'them@x.z', date: '2026-01-03T00:00:00Z', is_read: false },
];
const ACCOUNTS = [{ id: 'acct', email_address: 'me@x.z', aliases: [], folder_mappings: { sent: 'Sent' } }];

// What the pane passes when the conversation was opened from the unified inbox. a3 is the
// newest inbox message, so it is the row the threaded list shows.
const INBOX_VIEW = { anchorId: 'a3', folder: 'INBOX', accountId: null, row: THREAD[2] };

// The authoritative lookup the pane supplies. It returns a thread that has GAINED a
// message since the pane rendered, which is the staleness this module exists to handle.
const LATE_REPLY = { id: 'a4', account_id: 'acct', folder: 'INBOX', subject: 'Re: Hello', from_email: 'them@x.z', date: '2026-01-04T00:00:00Z', is_read: false };
const fetchThread = async () => ({ messages: [...THREAD, LATE_REPLY] });

const t = (key) => key;
let notifications = [];
const addNotification = n => notifications.push(n);

const ids = () => useStore.getState().messages.map(m => m.id).sort();
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const UNDO_WINDOW = 4500;

beforeEach(() => {
  requests = [];
  notifications = [];
  failNext = false;
  useStore.getState().setMessages(THREAD.map(m => ({ ...m })));
  useStore.setState({ accounts: ACCOUNTS });
});

describe('archiveThread', () => {
  test('removes the conversation at once and holds the request for the undo window', async () => {
    archiveThread(THREAD, { t, addNotification, ...INBOX_VIEW });

    assert.deepEqual(ids(), ['a2'], 'both inbox messages disappear immediately, and the Sent reply is not touched');
    assert.equal(notifications.length, 1, 'one notification for the conversation, not one per message');

    // Well into the undo window, and still nothing sent. Asserting this only
    // synchronously would pass even if the request fired on the next tick.
    await tick(UNDO_WINDOW / 2);
    assert.deepEqual(requests, [], 'nothing is sent yet: the user still has time to undo');

    assert.equal(notifications[0].title, 'message.archived.conversationTitle', 'worded for a conversation');

    await tick(UNDO_WINDOW + 50);
    assert.equal(requests.length, 1, 'one bulk request for the whole thread');
    assert.match(requests[0].url, /bulk-archive/);
    assert.deepEqual(requests[0].body.ids.sort(), ['a1', 'a3'], 'both inbox ids in a single call, and the Sent reply stays in Sent');
  });

  test('undo puts every message back and sends nothing', async () => {
    archiveThread(THREAD, { t, addNotification, ...INBOX_VIEW });
    assert.deepEqual(ids(), ['a2']);

    notifications[0].onUndo();
    assert.deepEqual(ids(), ['a1', 'a2', 'a3'], 'the whole conversation is restored, not just one message');

    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests, [], 'an undone action never reaches the server');
  });

  test('a failed request restores the thread and reports it', async () => {
    failNext = true;
    archiveThread(THREAD, { t, addNotification, ...INBOX_VIEW });
    await tick(UNDO_WINDOW + 50);

    assert.deepEqual(ids(), ['a1', 'a2', 'a3'], 'a thread that failed to archive must come back');
    const failure = notifications.find(n => n.type === 'error');
    assert.ok(failure, 'the user is told the archive failed');
  });
});

// Archive from the conversation pane takes the conversation out of the folder it is shown in, as
// the list's archive does: the reader's reply stays in Sent.
describe('archiveThread scoped to the viewed folder', () => {
  test('archives the Inbox copies, the late reply included, and leaves the Sent reply', async () => {
    archiveThread(THREAD, { t, addNotification, fetchThread, anchorId: 'a3', folder: 'INBOX', accountId: 'acct' });
    assert.deepEqual(ids(), ['a2'], 'the Sent reply stays in the list behind the pane');
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a3', 'a4']);
  });

  test('the unified inbox archives every account\'s Inbox copy; an account view only its own', async () => {
    const other = { id: 'b1', account_id: 'other', folder: 'INBOX', subject: 'Hello', from_email: 'them@x.z', date: '2026-01-01T00:00:00Z', is_read: true };
    const both = [...THREAD, other];
    useStore.getState().setMessages(both.map(m => ({ ...m })));
    archiveThread(both, { t, addNotification, anchorId: 'a3', folder: 'INBOX', accountId: null });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a3', 'b1']);

    requests = []; notifications = [];
    useStore.getState().setMessages(both.map(m => ({ ...m })));
    archiveThread(both, { t, addNotification, anchorId: 'a3', folder: 'INBOX', accountId: 'acct' });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a3']);
  });

  test('a conversation shown from another folder archives the copies there', async () => {
    const filed = THREAD.map(m => (m.folder === 'INBOX' ? { ...m, folder: 'Projects' } : m));
    archiveThread(filed, { t, addNotification, anchorId: 'a1', folder: 'Projects', accountId: 'acct' });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a3']);
  });

  test('with nothing left in the folder it archives the selected message, as the list does', async () => {
    archiveThread(THREAD, { t, addNotification, anchorId: 'a1', folder: 'Elsewhere', accountId: 'acct' });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids, ['a1']);
  });
});

describe('deleteThread', () => {
  test('deletes the conversation in one call and leaves the Sent reply alone', async () => {
    deleteThread(THREAD, { t, addNotification, ...INBOX_VIEW });
    await tick(UNDO_WINDOW + 50);
    assert.match(requests[0].url, /bulk-delete/);
    assert.deepEqual(requests[0].body.ids.sort(), ['a1', 'a3']);
  });
});

describe('a reply that arrives while the conversation is open', () => {
  test('is included in the action, not left behind', async () => {
    // The pane only knows the three messages it rendered. Acting on that snapshot would
    // archive three and leave the fourth in the inbox, resurrecting the thread.
    archiveThread(THREAD, { t, addNotification, fetchThread, ...INBOX_VIEW });
    await tick(UNDO_WINDOW + 50);

    assert.deepEqual(
      requests.at(-1).body.ids.sort(),
      ['a1', 'a3', 'a4'],
      'the late reply is archived along with the rest of the thread',
    );
  });

  test('is still spared from a spam report when the reader sent it', async () => {
    spamThread(THREAD, { t, addNotification, accounts: ACCOUNTS, fetchThread });
    await tick(UNDO_WINDOW + 50);

    const spammed = requests.map(r => r.url.match(/messages\/([^/]+)\/spam/)?.[1]).filter(Boolean).sort();
    assert.deepEqual(spammed, ['a1', 'a3', 'a4'], 'the freshly resolved list is filtered too');
  });
});

describe('moveThread', () => {
  test('moves the whole conversation into the chosen folder', async () => {
    moveThread(THREAD, 'Archive/2026', { t, addNotification, ...INBOX_VIEW });
    assert.deepEqual(ids(), [], 'the conversation leaves the current folder at once');
    assert.equal(notifications[0].body, 'Archive/2026', 'the toast names where it went');

    await tick(UNDO_WINDOW + 50);
    const move = requests.find(r => /bulk-move/.test(r.url));
    assert.ok(move, 'a move request was sent');
    assert.deepEqual(move.body.ids.sort(), ['a1', 'a2', 'a3'], 'every message moves together');
    assert.equal(move.body.folder, 'Archive/2026');
  });

  test('undo brings the conversation back and moves nothing', async () => {
    moveThread(THREAD, 'Archive/2026', { t, addNotification, ...INBOX_VIEW });
    notifications[0].onUndo();
    assert.deepEqual(ids(), ['a1', 'a2', 'a3']);
    await tick(UNDO_WINDOW + 50);
    assert.equal(requests.filter(r => /bulk-move/.test(r.url)).length, 0);
  });
});

// A saved reply in the conversation (marked is_draft by the thread route). Deleting a draft
// expunges it, so deleting or moving the conversation must leave it alone.
describe('drafts in the conversation', () => {
  const DRAFT = { id: 'd1', account_id: 'acct', folder: 'Drafts', subject: 'Re: Hello', from_email: 'me@x.z', date: '2026-01-05T00:00:00Z', is_read: true, is_draft: true };
  const withDraft = [...THREAD.map(m => ({ ...m, is_draft: false })), DRAFT];
  const fetchWithDraft = async () => ({ messages: [...withDraft, { ...LATE_REPLY, is_draft: false }] });

  test('delete leaves the draft, in the list and on the server, the late reply included', async () => {
    useStore.getState().setMessages(withDraft.map(m => ({ ...m })));
    deleteThread(withDraft, { t, addNotification, fetchThread: fetchWithDraft, anchorId: 'a3' });
    assert.deepEqual(ids(), ['d1'], 'only the draft stays in the list');
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a2', 'a3', 'a4']);
  });

  test('move leaves the draft too', async () => {
    moveThread(withDraft, 'Archive/2026', { t, addNotification, fetchThread: fetchWithDraft, anchorId: 'a1' });
    await tick(UNDO_WINDOW + 50);
    const move = requests.find(r => /bulk-move/.test(r.url));
    assert.deepEqual(move.body.ids.sort(), ['a1', 'a2', 'a3', 'a4']);
  });

  test('a conversation acted on from its draft (the Drafts folder) deletes only the draft', async () => {
    useStore.getState().setMessages(withDraft.map(m => ({ ...m })));
    deleteThread(withDraft, { t, addNotification, fetchThread: fetchWithDraft, anchorId: 'd1' });
    assert.deepEqual(ids(), ['a1', 'a2', 'a3'], 'the conversation it answers stays in the list');
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids, ['d1']);
  });

  test('archive leaves the draft in Drafts as well', async () => {
    archiveThread(withDraft, { t, addNotification, fetchThread: fetchWithDraft, anchorId: 'a1' });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a2', 'a3', 'a4']);
  });
});

describe('snoozeThread', () => {
  test('snoozes the newest inbox message, not the sent reply and not the whole thread', async () => {
    // a3 is the newest INBOX message. a2 is the reader's own sent reply, and snoozing it
    // would redeliver their own mail to them.
    const until = '2026-06-01T09:00:00.000Z';
    snoozeThread(THREAD, until, { t, addNotification });
    await tick(UNDO_WINDOW + 50);

    const snoozes = requests.filter(r => /\/snooze$/.test(r.url));
    assert.equal(snoozes.length, 1, 'exactly one message is snoozed');
    assert.match(snoozes[0].url, /messages\/a3\/snooze/, 'the newest inbox message');
    assert.equal(snoozes[0].body.until, until);
  });

  test('does nothing when the conversation has no inbox message left', async () => {
    const sentOnly = [THREAD[1]];
    snoozeThread(sentOnly, '2026-06-01T09:00:00.000Z', { t, addNotification });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(notifications, [], 'no toast for an action that had no target');
    assert.equal(requests.filter(r => /snooze/.test(r.url)).length, 0);
  });
});

describe('spamThread', () => {
  test('spares the reader\'s own replies', async () => {
    spamThread(THREAD, { t, addNotification, accounts: ACCOUNTS });

    // a2 is the reader's own sent reply. Reporting it as spam would train the filter
    // on their own address, so it stays put.
    assert.deepEqual(ids(), ['a2'], 'the sent reply is left alone');

    await tick(UNDO_WINDOW + 50);
    const spammed = requests.map(r => r.url.match(/messages\/([^/]+)\/spam/)?.[1]).filter(Boolean).sort();
    assert.deepEqual(spammed, ['a1', 'a3'], 'only the correspondent\'s messages are reported');
  });
});

// ---------------------------------------------------------------------------
// The pane shows every copy of the conversation, but the list it was opened from shows its
// copies in one folder and, outside the unified inbox, one account. Archive and delete act on
// what the list shows, as the list's own thread archive does (#361), and move on the account
// whose folders the picker listed, as the list's own move does.

// One email delivered to two accounts (#476), with A's Sent reply, A's unsent draft reply,
// and an earlier message of the thread that A's reader had already deleted.
const SPREAD = [
  { id: 'a-old', account_id: 'A', folder: 'Trash', message_id: '<0@x>', subject: 'Plan', date: '2026-02-01T00:00:00Z', is_read: true },
  { id: 'a-in', account_id: 'A', folder: 'INBOX', message_id: '<1@x>', subject: 'Re: Plan', date: '2026-02-02T00:00:00Z', is_read: false },
  { id: 'b-in', account_id: 'B', folder: 'INBOX', message_id: '<1@x>', subject: 'Re: Plan', date: '2026-02-02T00:00:00Z', is_read: false },
  { id: 'a-sent', account_id: 'A', folder: 'Sent', message_id: '<2@x>', subject: 'Re: Plan', date: '2026-02-03T00:00:00Z', is_read: true },
  { id: 'a-draft', account_id: 'A', folder: 'Drafts', message_id: '<3@x>', subject: 'Re: Plan', date: '2026-02-04T00:00:00Z', is_read: true },
];
// The unified inbox lists the conversation as one row for both accounts' inbox copies.
const GROUPED_ROW = { ...SPREAD[1], message_count: 2, unread_count: 2 };
const UNIFIED = { anchorId: GROUPED_ROW.id, folder: 'INBOX', accountId: null, row: GROUPED_ROW };
const sentIds = pattern => requests.find(r => pattern.test(r.url))?.body.ids.slice().sort();

describe('a conversation spread across folders and accounts', () => {
  beforeEach(() => {
    useStore.getState().setMessages([{ ...GROUPED_ROW }]);
    useStore.setState({ recentFolders: [] });
  });

  test('archive from the unified inbox takes every inbox copy and nothing filed elsewhere', async () => {
    archiveThread(SPREAD, { t, addNotification, ...UNIFIED });
    await tick(UNDO_WINDOW + 50);
    // Archiving is a move on IMAP: the Sent reply would leave Sent, the draft Drafts.
    assert.deepEqual(sentIds(/bulk-archive/), ['a-in', 'b-in']);
  });

  test('archive from one account\'s inbox stays in it, for a reply that arrives late too', async () => {
    const late = [
      { id: 'a-late', account_id: 'A', folder: 'INBOX', message_id: '<4@x>', date: '2026-02-05T00:00:00Z', is_read: false },
      { id: 'a-late-sent', account_id: 'A', folder: 'Sent', message_id: '<5@x>', date: '2026-02-06T00:00:00Z', is_read: true },
    ];
    archiveThread(SPREAD, {
      t, addNotification,
      anchorId: 'a-in', folder: 'INBOX', accountId: 'A', row: SPREAD[1],
      fetchThread: async () => ({ messages: [...SPREAD, ...late] }),
    });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(sentIds(/bulk-archive/), ['a-in', 'a-late'], 'the thread re-read at commit is held to the same view');
  });

  test('delete never sends a message that is already in Trash or Drafts', async () => {
    // bulk-delete expunges those instead of moving them to Trash, so sending them destroyed
    // the draft reply and the message the reader had already deleted. The ids sent come from
    // the thread as re-read at commit, here with a second draft saved during the undo window.
    const lateDraft = { id: 'a-draft-2', account_id: 'A', folder: 'Drafts', message_id: '<6@x>', date: '2026-02-05T00:00:00Z', is_read: true };
    deleteThread(SPREAD, {
      t, addNotification,
      ...UNIFIED,
      fetchThread: async () => ({ messages: [...SPREAD, lateDraft] }),
    });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(sentIds(/bulk-delete/), ['a-in', 'b-in']);
  });

  test('move sends only the account whose folders the picker listed', async () => {
    // The picker lists the row's account, A. bulk-move skips an account that has no folder at
    // that path and still answers ok, and the path was recorded as a recent folder of B too.
    moveThread(SPREAD, 'Projects', { t, addNotification, ...UNIFIED });
    await tick(UNDO_WINDOW + 50);
    const moved = sentIds(/bulk-move/);
    assert.ok(moved.includes('a-in') && moved.every(id => id.startsWith('a-')), `only A's copies are sent, got ${moved}`);
    assert.deepEqual(useStore.getState().recentFolders, [{ accountId: 'A', path: 'Projects' }], 'Projects is not recorded as a folder of B');
  });

  test('move sends the row itself when the thread holds none of its account\'s copies', async () => {
    // A message opened from a notification, from an account the unified thread leaves out.
    // Filtering the thread by its account leaves nothing, and sending nothing would close the
    // pane without moving anything or saying so.
    const row = { id: 'c-in', account_id: 'C', folder: 'INBOX', message_id: '<1@x>', date: '2026-02-02T00:00:00Z', is_read: true };
    moveThread(SPREAD, 'Projects', { t, addNotification, anchorId: 'c-in', folder: 'INBOX', accountId: 'C', row });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(sentIds(/bulk-move/), ['c-in']);
    assert.deepEqual(useStore.getState().recentFolders, [{ accountId: 'C', path: 'Projects' }]);
  });

  test('the list row is acted on when the thread holds only its inbox twin', async () => {
    // Gmail files a labelled message in INBOX and in the label's folder, and the thread keeps
    // only the INBOX copy. Archiving from the Projects folder takes the copy the list shows.
    const row = { ...SPREAD[1], id: 'a-proj', folder: 'Projects' };
    archiveThread(SPREAD, { t, addNotification, anchorId: 'a-proj', folder: 'Projects', accountId: 'A', row });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(sentIds(/bulk-archive/), ['a-proj']);
  });
});

// ---------------------------------------------------------------------------
// Resolving which messages an action operates on. These suites predate the action
// runners above and guard the staleness bug documented in threadActions.js.

const row = { id: 'row', thread_id: 't1' };
const cached = [{ id: 'a', is_read: false }, { id: 'b', is_read: false }];
const fresh = [...cached, { id: 'c', is_read: false }];   // 'c' arrived after the cache was built
const fetchFresh = () => Promise.resolve({ messages: fresh });

describe('the unread that could not be cleared', () => {
  test('acts on the server truth, not the snapshot taken when the thread was opened', async () => {
    // The bug: a reply arrived after the thread was expanded, so marking the thread read sent
    // only the cached ids. The newer message stayed unread on the server while the UI rendered
    // the row as read, hiding it. The badge then showed an unread nobody could reach.
    const got = await resolveThreadMessages({ message: row, isThreadRow: true, cached, fetchThread: fetchFresh });
    assert.deepEqual(got.map(m => m.id), ['a', 'b', 'c']);
  });

  test('a stale cache is ignored by default, so no caller inherits the bug', async () => {
    let fetched = false;
    await resolveThreadMessages({
      message: row, isThreadRow: true, cached,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.equal(fetched, true, 'the default must reach the server');
  });

  test('destructive actions cannot silently leave the newest messages behind', async () => {
    // A thread-wide delete or move built from a stale list drops whatever arrived since.
    const got = await resolveThreadMessages({ message: row, isThreadRow: true, cached, fetchThread: fetchFresh });
    assert.ok(got.some(m => m.id === 'c'), 'the message that arrived after expansion must be included');
  });
});

describe('resolveThreadMessages: the other paths', () => {
  test('an ordinary row is its own action and never hits the network', async () => {
    let fetched = false;
    const got = await resolveThreadMessages({
      message: row, isThreadRow: false, cached,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.deepEqual(got, [row]);
    assert.equal(fetched, false);
  });

  test('allowCache is honoured when a caller explicitly opts in', async () => {
    let fetched = false;
    const got = await resolveThreadMessages({
      message: row, isThreadRow: true, cached, allowCache: true,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.deepEqual(got.map(m => m.id), ['a', 'b']);
    assert.equal(fetched, false);
  });

  test('an empty or missing cache still fetches even when caching is allowed', async () => {
    for (const c of [undefined, null, [], 'nope']) {
      const got = await resolveThreadMessages({
        message: row, isThreadRow: true, cached: c, allowCache: true, fetchThread: fetchFresh,
      });
      assert.equal(got.length, 3, `cached=${String(c)} must fall through to the server`);
    }
  });
});

describe('resolveThreadMessages: degenerate responses', () => {
  test('an empty thread response falls back to the row rather than acting on nothing', async () => {
    // Reducing a thread action to zero messages would look like a silent no-op to the user.
    for (const bad of [{ messages: [] }, {}, null, undefined]) {
      const got = await resolveThreadMessages({
        message: row, isThreadRow: true, cached, fetchThread: () => Promise.resolve(bad),
      });
      assert.deepEqual(got, [row], `response=${JSON.stringify(bad)} must fall back to the row`);
    }
  });

  test('a rejected fetch propagates, so callers can roll their optimistic update back', async () => {
    await assert.rejects(
      resolveThreadMessages({
        message: row, isThreadRow: true, cached,
        fetchThread: () => Promise.reject(new Error('offline')),
      }),
      /offline/,
    );
  });
});
