import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    findUidByMessageId: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../services/hostValidation.js', async (importOriginal) => ({ ...(await importOriginal()), resolveForConnection: vi.fn(async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null })) }));
vi.mock('../services/connectionPolicy.js', async (importOriginal) => ({ ...(await importOriginal()), getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: true, allowInsecureTls: true })) }));
import express from 'express';
import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import routes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { ImapManager } from '../services/imapManager.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

// #585: the metadata recorded for the Sent copy carried To and Cc but not the Bcc.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null, signature: null };
let server, base;
beforeAll(async () => {
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: vi.fn(async () => ({})) } });
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => vi.clearAllMocks());

describe('Sent copy metadata', () => {
  it('records the Bcc next to To and Cc', async () => {
    const res = await fetch(`${base}/api/mail/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'bcc1' },
      body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], cc: ['cc@example.com'], bcc: ['Hidden <hidden@example.com>'], subject: 'Hi', body: 'Hello' }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(imapManager.upsertSentMessageRecord).toHaveBeenCalled());
    const meta = imapManager.upsertSentMessageRecord.mock.calls[0][3];
    expect(meta.bcc).toEqual([expect.objectContaining({ email: 'hidden@example.com' })]);
    expect(meta.cc).toEqual([expect.objectContaining({ email: 'cc@example.com' })]);
  });

  it('records the Bcc when the server saves the Sent copy itself', async () => {
    imapManager.findUidByMessageId.mockImplementation(ImapManager.prototype.findUidByMessageId);
    let savedId = null; // the Message-ID of the copy the provider filed in Sent
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => {}), close: vi.fn(),
      getMailboxLock: vi.fn(async () => ({ release: () => {} })),
      // Answers only the query imapflow's own compiler makes of a search for that copy.
      search: vi.fn(async (criteria) => {
        const sent = searchCompiler(client, criteria).map(a => a.value).join(' ').toLowerCase();
        return savedId && sent === `header message-id ${savedId.replace(/[<>]/g, '')}`.toLowerCase() ? [7] : [];
      }) });
    ImapFlow.mockImplementation(function () { return client; });
    // An OAuth account, whose provider files the Sent copy itself. Fake the clock only once the
    // request is in the route: fetch waits on a setTimeout(0) before it reuses an idle keep-alive
    // socket, so faking it earlier stalls the request.
    createAccountSmtpTransport.mockImplementationOnce(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      return { account: { ...account, oauth_provider: 'google' }, transport: { sendMail: vi.fn(async () => ({})) } };
    });
    try {
      const res = await fetch(`${base}/api/mail/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'bcc2' },
        body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], bcc: ['Hidden <hidden@example.com>'], subject: 'Hi', body: 'Hello' }),
      });
      expect(res.status).toBe(200);
      savedId = (await res.json()).messageId;
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => expect(imapManager.upsertSentMessageRecord).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
    const [, folder, uid, meta] = imapManager.upsertSentMessageRecord.mock.calls[0];
    expect([folder, uid]).toEqual(['Sent', 7]);
    expect(meta.bcc).toEqual([expect.objectContaining({ email: 'hidden@example.com' })]);
  });
});
