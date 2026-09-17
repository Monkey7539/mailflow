import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Same mock surface the other mail.* route tests use so importing mail.js is side-effect free.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: { fetchHeaders: vi.fn() },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let ctx;
beforeEach(async () => {
  query.mockReset();
  imapManager.fetchHeaders.mockReset();
  if (!ctx) ctx = await startServer();
});
afterAll(() => ctx?.server?.close());

// The IMAP headers a Finnish sender produces: subject in an ISO-8859-1 encoded-word.
const LATIN1_HEADERS = [
  'From: test@example.com',
  'Subject: =?iso-8859-1?Q?Hyv=E4=E4_p=E4iv=E4=E4?=',
  '',
].join('\r\n');

function mockMessage(subject) {
  // First query: the message row. Second: the account row.
  query
    .mockResolvedValueOnce({ rows: [{ id: MESSAGE_ID, account_id: ACCOUNT_ID, uid: 42, folder: 'INBOX', subject, user_id: 'user-1' }] })
    .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] })
    .mockResolvedValue({ rows: [] });
  imapManager.fetchHeaders.mockResolvedValue(LATIN1_HEADERS);
}

describe('GET /messages/:id/headers subject handling (#454)', () => {
  it('never replaces a subject that is already stored', async () => {
    // The reported bug: opening this modal rewrote the list and the open message with a
    // re-derived subject. Repair is for a MISSING subject only, so a stored one wins.
    //
    // The stored subject deliberately differs from the one in the headers. Using the same
    // text either side would pass whether or not the route re-derives, which is exactly the
    // mistake that let this behavior go unnoticed.
    mockMessage('Stored subject the client already shows');
    const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/headers`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.subject).toBe('Stored subject the client already shows');
    expect(body.subject).not.toBe('Hyvää päivää');
    // No UPDATE is issued when a subject is already present.
    const updates = query.mock.calls.filter(([sql]) => /UPDATE messages SET subject/i.test(sql));
    expect(updates).toHaveLength(0);
  });

  it('repairs a missing subject, decoded in its declared charset', async () => {
    mockMessage('(no subject)');
    const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/headers`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.subject).toBe('Hyvää päivää');
    expect(body.subject).not.toMatch(/�/);
    const updates = query.mock.calls.filter(([sql]) => /UPDATE messages SET subject/i.test(sql));
    expect(updates).toHaveLength(1);
    expect(updates[0][1][0]).toBe('Hyvää päivää');
  });
});
