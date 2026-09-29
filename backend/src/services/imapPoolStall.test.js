// What frees a pooled connection whose command never gets a reply?
//
// makeClientCfg used to pass `commandTimeout: 30000`, and the pool's timings were built on
// it, but no imapflow release has that option. The only bound on an unanswered command was
// socketTimeout, 5 minutes of silence, and the slot stayed taken for all of it. With a pool
// of one (Yahoo), every pooled operation on the account failed as busy meanwhile.
//
// These run a REAL ImapFlow against a local fake server, because the fix leans on
// imapflow internals (client.socket, client.socketTimeout) and on its socket-timeout
// handler telling an overdue command from a quiet but healthy session. An imapflow upgrade
// that changes any of that has to fail here. Only time is faked: socket.setTimeout is
// scaled so the 30s stall timeout fires in milliseconds.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import net from 'node:net';

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

import { withFreshClient, evictPool, isConnectionRefusal, POOL_STALL_TIMEOUT_MS } from './imapManager.js';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const STALL_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Just enough IMAP for imapflow to log in, select INBOX and fetch. With stallFetch set, a
// FETCH is read and never answered, like a half-open connection.
function startFakeImap() {
  const state = { stallFetch: false, commands: [], connections: 0, sockets: new Set() };
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1] fake ready\r\n');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      let end;
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const [tag, command = '', sub = ''] = line.split(' ');
        const verb = command.toUpperCase() === 'UID' ? sub.toUpperCase() : command.toUpperCase();
        state.commands.push(verb);
        if (verb === 'SELECT' || verb === 'EXAMINE') {
          socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 2] ok\r\n* FLAGS (\\Seen)\r\n${tag} OK [READ-WRITE] done\r\n`);
        } else if (verb === 'LIST') {
          socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
        } else if (verb === 'FETCH') {
          if (!state.stallFetch) socket.write(`* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n${tag} OK done\r\n`);
        } else if (verb === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK done\r\n`);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  return { server, state };
}

let fake;
let ACCOUNT;
const realSetTimeout = net.Socket.prototype.setTimeout;

beforeAll(async () => {
  fake = startFakeImap();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  ACCOUNT = {
    id: 'acct-stall',
    imap_host: '127.0.0.1',
    imap_port: fake.server.address().port,
    imap_tls: false,
    imap_skip_tls_verify: false,
    auth_user: 'user',
    auth_pass: 'enc',
  };
  vi.spyOn(net.Socket.prototype, 'setTimeout').mockImplementation(function (ms, ...rest) {
    return realSetTimeout.call(this, ms === POOL_STALL_TIMEOUT_MS ? STALL_MS : ms, ...rest);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => fake.server.close(resolve));
});

beforeEach(() => {
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  fake.state.stallFetch = false;
  fake.state.commands = [];
  fake.state.connections = 0;
  // connectImapClient logs every client 'error'; the stall is expected to be one.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  evictPool(ACCOUNT.id);
  for (const socket of fake.state.sockets) socket.destroy();
  console.error.mockRestore();
});

const fetchFlags = async (client) => {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const rows = [];
    for await (const msg of client.fetch('1', { uid: true, flags: true }, { uid: true })) rows.push(msg.uid);
    return rows;
  } finally {
    lock.release();
  }
};

describe('pooled command that never gets a reply', () => {
  it('closes the connection at the stall timeout instead of holding the slot for socketTimeout', async () => {
    fake.state.stallFetch = true;
    let stalledClient;
    const outcome = await Promise.race([
      withFreshClient(ACCOUNT, (client) => { stalledClient = client; return fetchFlags(client); })
        .then(() => 'answered', (err) => err),
      sleep(3000).then(() => 'still waiting'),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect(stalledClient.usable).toBe(false);
    // Named as a timeout, which fetchMessageBody retries, and not as imapflow's 'Connection
    // not available', which would read as the provider refusing connections.
    expect(outcome.message).toMatch(/timed out/);
    expect(isConnectionRefusal(outcome.message)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('IMAP error'), 'Socket timeout');

    // The slot is free: the next pooled operation gets a new connection that works.
    fake.state.stallFetch = false;
    let nextClient;
    const rows = await withFreshClient(ACCOUNT, (client) => { nextClient = client; return fetchFlags(client); });
    expect(rows).toEqual([1]);
    expect(nextClient).not.toBe(stalledClient);
    expect(fake.state.connections).toBe(2);
  });

  it('keeps a lease that is quiet while holding a mailbox lock', async () => {
    // Between two commands (a DB write, say) nothing is owed, so a quiet socket is no
    // stall. imapflow answers the timer with a NOOP rather than closing.
    const usable = await withFreshClient(ACCOUNT, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        await sleep(STALL_MS * 4);
        return client.usable;
      } finally {
        lock.release();
      }
    });

    expect(usable).toBe(true);
    expect(fake.state.commands).toContain('NOOP');
  });

  it('puts the normal timeout back when the lease ends', async () => {
    // An unused pooled connection with no mailbox selected is closed when its timer
    // fires, so leaving the stall timeout on it would throw away pooled sessions (the
    // pre-warmed one among them) and cost a fresh login on the next operation.
    let leased;
    await withFreshClient(ACCOUNT, async (client) => { leased = client; });
    await sleep(STALL_MS * 4);

    expect(leased.usable).toBe(true);
    let reused;
    await withFreshClient(ACCOUNT, async (client) => { reused = client; });
    expect(reused).toBe(leased);
    expect(fake.state.connections).toBe(1);
  });
});
