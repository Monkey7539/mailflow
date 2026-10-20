import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    fetchAttachment: vi.fn(async () => Buffer.from('%PDF-1.4')),
    fetchRawMessage: vi.fn(async () => Buffer.from('From: a@example.com\r\nSubject: Original\r\n\r\nHello.\r\n')),
    pluginFacade: {},
  },
}));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

// The row written for the Sent copy had no paperclip, whatever the message carried, and the sync
// that follows never corrects it: it skips a uid the row already holds.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null, signature: null };
const ORIGINAL_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const original = {
  id: ORIGINAL_ID, uid: 9, folder: 'INBOX', subject: 'Original', account_id: 'a1',
  attachments: [{ part: '2', filename: 'report.pdf', type: 'application/pdf', size: 8 }],
};
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sendMail = vi.fn(async () => ({}));
let server, base;
beforeAll(async () => {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM messages m')) return { rows: [original] };
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    return { rows: [{ preferences: {}, id: 'book1' }] };
  });
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  sendMail.mockClear();
  imapManager.appendToSent.mockClear();
  imapManager.upsertSentMessageRecord.mockClear();
});

let key = 0;
async function send(fields) {
  const res = await fetch(`${base}/api/mail/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': `att${++key}` },
    body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Hi', body: 'Hello', ...fields }),
  });
  expect(res.status).toBe(200);
  return {
    hasAttachments: imapManager.upsertSentMessageRecord.mock.calls[0][3].hasAttachments,
    sentCopy: imapManager.appendToSent.mock.calls[0][2].toString(),
  };
}

// The flag recorded for the Sent copy, checked against the copy itself: a sync sets the paperclip
// when a part is marked Content-Disposition: attachment, which is how every file here goes out.
async function sentPaperclip(fields) {
  const { hasAttachments, sentCopy } = await send(fields);
  expect(hasAttachments).toBe(/^Content-Disposition: attachment/im.test(sentCopy));
  return hasAttachments;
}

describe('the Sent row paperclip', () => {
  it('is set for a file attached from the computer', async () => {
    expect(await sentPaperclip({
      attachments: [{ filename: 'notes.txt', content: Buffer.from('notes').toString('base64'), contentType: 'text/plain' }],
    })).toBe(true);
  });

  it('is set for an attachment forwarded from another message', async () => {
    expect(await sentPaperclip({ forwardedAttachments: [{ messageId: ORIGINAL_ID, part: '2' }] })).toBe(true);
    expect(imapManager.fetchAttachment).toHaveBeenCalledWith(account, 9, 'INBOX', '2');
  });

  it('is set for a message forwarded as an attachment', async () => {
    expect(await sentPaperclip({ forwardedMessages: [ORIGINAL_ID] })).toBe(true);
    expect(imapManager.fetchRawMessage).toHaveBeenCalledWith(account, 9, 'INBOX');
  });

  // nodemailer marks message/* parts inline, so a sync would usually leave this one without a
  // paperclip, although the attachment list shows the .eml. The row sets it, to match the list.
  it('is set for an .eml attached from the computer, which goes out inline', async () => {
    const { hasAttachments, sentCopy } = await send({
      attachments: [{ filename: 'original.eml', content: Buffer.from('Subject: Original\r\n\r\nHello.\r\n').toString('base64'), contentType: 'message/rfc822' }],
    });
    expect(hasAttachments).toBe(true);
    expect(sentCopy).toMatch(/^Content-Disposition: inline; filename="?original\.eml"?\r?$/im);
    expect(sentCopy).not.toMatch(/^Content-Disposition: attachment/im);
  });

  it('is not set for images pasted into the body', async () => {
    expect(await sentPaperclip({ bodyIsHtml: true, body: `<p>Logo:</p><p><img src="data:image/png;base64,${PIXEL}"></p>` })).toBe(false);
    // The image did go out, as an inline part the HTML shows by its Content-ID.
    expect(sendMail.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({ contentDisposition: 'inline', cid: expect.any(String), contentType: 'image/png' }),
    ]);
  });

  it('is not set for a message without files', async () => {
    expect(await sentPaperclip({})).toBe(false);
  });
});
