import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// requireAuth runs for real; only its users-table lookup is stubbed, so the session that
// /login creates below belongs to a live account.
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [{ id: 'u1' }] })) }));

import express from 'express';
import session from 'express-session';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import { requireAuth } from './auth.js';
import { mountBodyParsers } from './bodyParsers.js';

const LARGE_BODY_PATHS = ['/api/mail/send', '/api/mail/draft', '/api/gtd/pet/import'];
const TWO_MB = 2 * 1024 * 1024;
// Over the global 1 MB limit, so only the larger limits can accept it.
const OVER_1MB = JSON.stringify({ text: 'x'.repeat(TWO_MB) });

// Same order as index.js: the body parsers, then the session, then the routers, which each
// start with router.use(requireAuth) except sign-in. `parsed` records every body that got past
// the parsers, which is how far a request travels before a router can turn it away. `answered`
// records whether the whole request had arrived by the time its response went out.
const parsed = [];
const answered = [];
function buildApp() {
  const app = express();
  const sessionMiddleware = session(buildSessionOptions(new session.MemoryStore(), 'test-secret-'.padEnd(40, 'x')));
  app.use((req, res, next) => {
    res.on('finish', () => answered.push({ status: res.statusCode, bodyReceived: req.complete }));
    next();
  });
  mountBodyParsers(app, sessionMiddleware);
  app.use(sessionMiddleware);
  app.get('/login', (req, res) => { req.session.userId = 'u1'; res.json({ ok: true }); });
  app.use((req, _res, next) => {
    if (req.body?.text) parsed.push(req.path);
    next();
  });
  // Stands in for POST /api/auth/login, which parses a JSON body from a signed-out client.
  app.post('/api/auth/login', (req, res) => res.json({ received: req.body }));
  const routes = express.Router();
  routes.use(requireAuth);
  routes.post([...LARGE_BODY_PATHS, '/api/rules'], (req, res) => res.json({ received: req.body.text.length }));
  app.use(routes);
  return app;
}

let server;
let base;
let cookie;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/login`);
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  parsed.length = 0;
  answered.length = 0;
});

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
});

describe('JSON body limits and sign-in', () => {
  it.each(LARGE_BODY_PATHS)('turns away a signed-out POST to %s without parsing its body', async (path) => {
    // The bug: these parsers ran before the session was loaded, so anyone could make the
    // server read, inflate and parse up to 35 MB before a router answered 401.
    const res = await post(path, OVER_1MB);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(parsed).toEqual([]);
    // The 401 waits until the rest of the body has arrived and been discarded. Behind nginx
    // every request is Connection: close, and answering one with body data still unread
    // resets the connection, which can lose the 401 on the way to the client.
    expect(answered).toEqual([{ status: 401, bodyReceived: true }]);

    // A body that cannot parse gets the same 401, so the parser never ran.
    const malformed = await post(path, '{');
    expect(malformed.status).toBe(401);
  });

  it.each(LARGE_BODY_PATHS)('still accepts a signed-in body over 1 MB at %s', async (path) => {
    const res = await post(path, OVER_1MB, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: TWO_MB });
  });

  it('keeps the 1 MB limit on every other route', async () => {
    const res = await post('/api/rules', OVER_1MB, { cookie });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request too large. Total attachment size must not exceed 25 MB.' });
  });

  it('still parses a signed-out body on a route that does not require sign-in', async () => {
    const res = await post('/api/auth/login', JSON.stringify({ username: 'a' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: { username: 'a' } });
  });
});
