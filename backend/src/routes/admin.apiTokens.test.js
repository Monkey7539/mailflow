import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { tx } = vi.hoisted(() => ({ tx: { query: null } }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn(async fn => fn({ query: tx.query })) }));
vi.mock('../middleware/auth.js', () => ({
  requireAdmin: (req, _res, next) => { req.session = { userId: 'admin-1', username: 'admin' }; next(); },
}));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(), invalidateConnectionPolicyCache: vi.fn() }));
vi.mock('../services/apiTokens.js', () => ({ invalidateApiTokenSettingsCache: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: {} }));
vi.mock('../services/userSessions.js', () => ({ destroyUserSessions: vi.fn() }));

import express from 'express';
import adminRoutes, { setUserPassword } from './admin.js';
import { query } from '../services/db.js';
import { invalidateApiTokenSettingsCache } from '../services/apiTokens.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  invalidateApiTokenSettingsCache.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const patch = body => fetch(`${base}/api/admin/settings`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const switchWrites = () => query.mock.calls.filter(([sql]) => sql.includes("'api_tokens_enabled'")).map(([, params]) => params);

describe('the admin switch for API tokens', () => {
  it.each([[true, 'true', 'on'], [false, 'false', 'off']])('turns them %s and drops the cached setting at once', async (value, stored, word) => {
    const res = await patch({ api_tokens_enabled: value });
    expect(res.status).toBe(200);
    expect(switchWrites()).toEqual([[stored]]);
    expect(invalidateApiTokenSettingsCache).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(`[admin] admin turned API tokens ${word}`);
  });

  it('takes only a boolean, as the other switches do', async () => {
    for (const value of ['true', 1, null, 'on']) {
      query.mockClear();
      expect((await patch({ api_tokens_enabled: value })).status).toBe(200);
      expect(switchWrites(), JSON.stringify(value)).toEqual([]);
    }
  });

  it('still takes effect when a setting after it is refused', async () => {
    const res = await patch({ api_tokens_enabled: false, mfa_enforcement: 'sometimes' });
    expect(res.status).toBe(400);
    expect(switchWrites()).toEqual([['false']]);
    expect(invalidateApiTokenSettingsCache).toHaveBeenCalled();
  });
});

describe('an admin setting a password', () => {
  it('deletes the user\'s API tokens in the same transaction as the new password', async () => {
    const inTransaction = [];
    tx.query = vi.fn(async (sql) => { inTransaction.push(sql); return { rows: [] }; });
    query.mockResolvedValue({ rows: [{ username: 'maria' }] });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await setUserPassword({ params: { id: 'b2b2b2b2-0000-4000-8000-000000000002' }, body: { password: 'nova-senha-123' },
      session: { userId: 'admin-1', username: 'admin' }, sessionID: 's', ip: '203.0.113.7' }, res);
    expect(inTransaction[0]).toMatch(/^UPDATE users SET password_hash/);
    expect(inTransaction).toContain('DELETE FROM api_tokens WHERE user_id = $1');
    expect(query.mock.calls.some(([sql]) => sql.includes('api_tokens'))).toBe(false);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
