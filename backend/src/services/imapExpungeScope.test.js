// A delete must expunge only the messages it was asked to.
//
// imapflow's messageDelete flags the range \Deleted and then expunges. Only with UIDPLUS
// (RFC 4315) is that a UID EXPUNGE of the range; otherwise it is a plain EXPUNGE, which removes
// every message in the mailbox that carries \Deleted, including ones another client flagged
// and has not expunged yet (Thunderbird's "mark it as deleted", Roundcube's flag_for_deletion),
// which that client can still undelete. The fake connection hands messageDelete to imapflow's
// own EXPUNGE command, so the choice between the two is imapflow's, not a model of it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import imapflowExpunge from 'imapflow/lib/commands/expunge.js';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapManager, evictPool, ACQUIRE_TIMEOUT_MS } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const acct = {
  id: 'expunge-scope', user_id: 'u1', imap_host: 'imap.example.com', imap_port: 993,
  imap_tls: true, auth_user: 'u', auth_pass: 'enc', enabled: true,
};
const DELETED = '\\Deleted';

// An IMAP server with neither MOVE nor UIDPLUS unless `capabilities` says otherwise. In INBOX,
// 4 and 5 are ordinary and 6 and 7 were flagged \Deleted by another client that has not
// expunged them; Drafts is the same with 1 ordinary and 2 flagged; nothing in Trash is flagged.
// `refuseSearch` and `refuseUnflag` make the server answer the \Deleted SEARCH, or a STORE
// -FLAGS, with NO; `refuseFlag` lists UIDs whose STORE +FLAGS it answers with NO. A test can set
// `afterStore` to hold a session once a STORE has been applied.
function makeServer({ capabilities = ['IMAP4rev1'], refuseSearch = false, refuseUnflag = false, refuseFlag = [] } = {}) {
  const folder = (entries, uidNext) => ({ flags: new Map(entries.map(([uid, f = []]) => [uid, new Set(f)])), uidNext });
  return {
    capabilities, refuseSearch, refuseUnflag, refuseFlag,
    folders: {
      INBOX: folder([[4], [5], [6, [DELETED]], [7, [DELETED]]], 8),
      Drafts: folder([[1], [2, [DELETED]]], 3),
      Trash: folder([[1], [2]], 3),
      Archive: folder([], 1),
    },
    commands: [],
    afterStore: null,
  };
}

// UID set to a list, with RFC 3501 `*` semantics.
function uidSet(range, present) {
  const max = present.length ? Math.max(...present) : 0;
  const out = new Set();
  for (const part of String(range).split(',')) {
    const [a, b = a] = part.split(':').map(v => (v === '*' ? max : Number(v)));
    for (let u = Math.min(a, b); u <= Math.max(a, b); u++) out.add(u);
  }
  return present.filter(u => out.has(u));
}

function connectionTo(server) {
  const box = (conn) => server.folders[conn.mailbox.path];
  // imapflow's resolveRange turns an array into a sequence string before a command runs.
  const store = async (conn, op, range, flags, options) => {
    if (!options?.uid) throw new Error('STORE by sequence number');
    const uids = uidSet([].concat(range).join(','), [...box(conn).flags.keys()]);
    server.commands.push([`STORE ${op}FLAGS`, uids]);
    // imapflow store.js: a NO resolves false
    if (op === '-' && server.refuseUnflag) return false;
    if (op === '+' && uids.some(u => server.refuseFlag.includes(u))) return false;
    for (const u of uids) for (const f of flags) box(conn).flags.get(u)[op === '+' ? 'add' : 'delete'](f);
    await server.afterStore?.(op, uids);
    return true;
  };
  return Object.assign(new EventEmitter(), {
    capabilities: new Map(server.capabilities.map(c => [c, true])),
    enabled: new Set(),
    states: { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 },
    state: 2,
    mailbox: false,
    log: { warn() {}, debug() {} },
    usable: true,
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    logout: vi.fn(async () => {}),
    // The pool refreshes a reused session's mailbox view with a NOOP before handing it out.
    noop: vi.fn(async () => true),

    async getMailboxLock(path) {
      this.mailbox = { path, exists: server.folders[path].flags.size };
      this.state = this.states.SELECTED;
      return { release: () => {} };
    },
    async status(path) {
      return { path, uidNext: server.folders[path].uidNext };
    },
    async search(q) {
      const present = [...box(this).flags.keys()];
      if (q.deleted) {
        server.commands.push(['SEARCH DELETED']);
        if (server.refuseSearch) return false; // imapflow search.js: a NO resolves false
        return present.filter(u => box(this).flags.get(u).has(DELETED));
      }
      return uidSet(q.uid, present);
    },
    messageFlagsAdd(range, flags, options) { return store(this, '+', range, flags, options); },
    messageFlagsRemove(range, flags, options) { return store(this, '-', range, flags, options); },
    // COPY keeps the flags (RFC 3501 6.4.7).
    async messageCopy(range, destination, options) {
      if (!options?.uid) throw new Error('COPY by sequence number');
      const src = box(this);
      const dst = server.folders[destination];
      const uids = uidSet([].concat(range).join(','), [...src.flags.keys()]);
      server.commands.push(['COPY', uids, destination]);
      const uidMap = new Map(uids.map(u => [u, dst.uidNext++]));
      for (const [from, to] of uidMap) dst.flags.set(to, new Set(src.flags.get(from)));
      const res = { path: this.mailbox.path, destination };
      if (this.capabilities.has('UIDPLUS')) Object.assign(res, { uidValidity: 1n, uidMap });
      return res;
    },
    messageDelete(range, options) {
      return imapflowExpunge(this, [].concat(range).join(','), options);
    },
    // What imapflow's EXPUNGE command sends: a UID EXPUNGE of the range, or a plain EXPUNGE.
    async exec(command, attributes) {
      const src = box(this);
      const flagged = [...src.flags].filter(([, f]) => f.has(DELETED)).map(([u]) => u);
      let gone;
      if (command === 'EXPUNGE') gone = flagged;
      else if (command === 'UID EXPUNGE') gone = uidSet(attributes[0].value, flagged);
      else throw new Error(`unexpected ${command}`);
      server.commands.push([command, gone]);
      for (const u of gone) src.flags.delete(u);
      return { next: () => {}, response: { attributes: [] } };
    },
  });
}

// A folder as { uid: [flags] }.
const contents = (folder) => Object.fromEntries([...server.folders[folder].flags].map(([u, f]) => [u, [...f]]));
const expunges = () => server.commands.filter(([c]) => c.endsWith('EXPUNGE'));

let server;
let mgr;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  evictPool(acct.id);
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  ImapFlow.mockImplementation(function () { return connectionTo(server); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mgr = new ImapManager(null);
  vi.clearAllTimers(); // the constructor's schedulers are not under test
  mgr.syncFolderOnDemand = vi.fn(async () => {});
});

afterEach(() => {
  evictPool(acct.id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('on a server without UIDPLUS, messages another client flagged \\Deleted', () => {
  beforeEach(() => { server = makeServer(); });

  it('survive a permanent delete of another message in their folder, still flagged', async () => {
    await expect(mgr.permanentDeleteMessage(acct, 1, 'Drafts')).resolves.toBe(true);
    expect(contents('Drafts')).toEqual({ 2: [DELETED] });
  });

  it('survive a move out of their folder on a server without MOVE', async () => {
    await mgr.moveMessage(acct, 5, 'INBOX', 'Archive');
    expect(contents('INBOX')).toEqual({ 4: [], 6: [DELETED], 7: [DELETED] });
    expect(contents('Archive')).toEqual({ 1: [] });
  });

  it('survive a bulk move out of their folder on a server without MOVE', async () => {
    const r = await mgr.bulkMoveMessages(acct, [4, 5], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([4, 5]);
    expect(contents('INBOX')).toEqual({ 6: [DELETED], 7: [DELETED] });
  });

  it('survive a bulk permanent delete', async () => {
    const r = await mgr.bulkPermanentDelete(acct, [4, 5], 'INBOX');
    expect(r).toEqual({ succeeded: [4, 5], failed: [] });
    expect(contents('INBOX')).toEqual({ 6: [DELETED], 7: [DELETED] });
  });
});

// The pool runs an account's work on several sessions at once, and deletes in one folder do
// overlap: the frontend sends every delete still in its undo window together when the page
// closes, and inbox rules move mail while the user does.
describe('on a server without UIDPLUS, two deletes in one folder at once', () => {
  beforeEach(() => { server = makeServer(); });

  // The first is held once it has taken \Deleted off 6 and 7, and the second, once it has
  // flagged 5, until the first is done. Unless they take turns, the second searches while 6 and
  // 7 are unflagged and expunges after the first has flagged them again.
  it.each([
    ['permanentDeleteMessage', (uid) => mgr.permanentDeleteMessage(acct, uid, 'INBOX')],
    ['moveMessage', (uid) => mgr.moveMessage(acct, uid, 'INBOX', 'Archive')],
  ])('the messages another client flagged survive two overlapping %s calls', async (_name, remove) => {
    let resumeFirst;
    let finishFirst;
    const firstHeld = new Promise(r => { resumeFirst = r; });
    const firstFinished = new Promise(r => { finishFirst = r; });
    let held = false;
    server.afterStore = async (op, uids) => {
      if (op === '-' && !held) { held = true; await firstHeld; }
      if (op === '+' && uids.includes(5)) await firstFinished;
    };
    const first = remove(4);
    await vi.advanceTimersByTimeAsync(0);
    const second = remove(5);
    await vi.advanceTimersByTimeAsync(0);
    resumeFirst();
    await first;
    finishFirst();
    await second;
    expect(contents('INBOX')).toEqual({ 6: [DELETED], 7: [DELETED] });
  });

  it('a delete that waits too long for its turn fails and expunges nothing', async () => {
    let resumeFirst;
    const firstHeld = new Promise(r => { resumeFirst = r; });
    let held = false;
    server.afterStore = async (op) => { if (op === '-' && !held) { held = true; await firstHeld; } };
    const first = mgr.permanentDeleteMessage(acct, 4, 'INBOX');
    await vi.advanceTimersByTimeAsync(0);
    const second = mgr.permanentDeleteMessage(acct, 5, 'INBOX').catch(err => err);
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS);
    resumeFirst();
    await first;
    expect(await second).toBeInstanceOf(Error);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Not expunging UID(s) 5 in INBOX: an earlier delete there has not finished'));
    expect(contents('INBOX')).toEqual({ 5: [], 6: [DELETED], 7: [DELETED] });
  });
});

describe('on a server without UIDPLUS, with nothing else in the folder flagged', () => {
  beforeEach(() => { server = makeServer(); });

  it('permanentDeleteMessage searches, then flags and expunges its message', async () => {
    await expect(mgr.permanentDeleteMessage(acct, 1, 'Trash')).resolves.toBe(true);
    expect(server.commands).toEqual([['SEARCH DELETED'], ['STORE +FLAGS', [1]], ['EXPUNGE', [1]]]);
    expect(contents('Trash')).toEqual({ 2: [] });
  });
});

describe('on a server without UIDPLUS, when the other flagged messages cannot be protected', () => {
  describe.each([
    ['the \\Deleted SEARCH is refused', { refuseSearch: true }, 'the \\Deleted SEARCH returned false'],
    ['clearing their \\Deleted flag is refused', { refuseUnflag: true }, 'could not clear \\Deleted'],
  ])('because %s', (_label, opts, reason) => {
    beforeEach(() => { server = makeServer(opts); });

    it('permanentDeleteMessage fails, expunges nothing and logs why', async () => {
      await expect(mgr.permanentDeleteMessage(acct, 1, 'Drafts')).rejects.toThrow();
      expect(contents('Drafts')).toEqual({ 1: [], 2: [DELETED] });
      expect(expunges()).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`Not expunging UID(s) 1 in Drafts: ${reason}`));
    });

    it('bulkPermanentDelete reports the batch failed, expunges nothing and logs why', async () => {
      const r = await mgr.bulkPermanentDelete(acct, [4, 5], 'INBOX');
      expect(r).toEqual({ succeeded: [], failed: [4, 5] });
      expect(contents('INBOX')).toEqual({ 4: [], 5: [], 6: [DELETED], 7: [DELETED] });
      expect(expunges()).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`Not expunging UID(s) 4,5 in INBOX: ${reason}`));
    });

    it('moveMessage keeps the copy, leaves the source in place and warns', async () => {
      await mgr.moveMessage(acct, 5, 'INBOX', 'Archive');
      expect(contents('INBOX')).toEqual({ 4: [], 5: [], 6: [DELETED], 7: [DELETED] });
      expect(contents('Archive')).toEqual({ 1: [] });
      expect(expunges()).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`Not expunging UID(s) 5 in INBOX: ${reason}`));
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('in both folders'));
    });
  });
});

describe('on a server without UIDPLUS, when their \\Deleted flag cannot be put back', () => {
  beforeEach(() => { server = makeServer({ refuseFlag: [2] }); });

  it('the delete still succeeds, and the log names them', async () => {
    await expect(mgr.permanentDeleteMessage(acct, 1, 'Drafts')).resolves.toBe(true);
    expect(contents('Drafts')).toEqual({ 2: [] });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('UID(s) 2 in Drafts'));
  });
});

describe('on a server with UIDPLUS', () => {
  beforeEach(() => { server = makeServer({ capabilities: ['IMAP4rev1', 'UIDPLUS'] }); });

  it('permanentDeleteMessage expunges by UID with no extra round trips', async () => {
    await mgr.permanentDeleteMessage(acct, 1, 'Drafts');
    expect(server.commands).toEqual([['STORE +FLAGS', [1]], ['UID EXPUNGE', [1]]]);
    expect(contents('Drafts')).toEqual({ 2: [DELETED] });
  });
});
