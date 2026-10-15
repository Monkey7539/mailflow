import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real rate limiter and replay guard run against this in-memory Redis.
const { rs, settings } = vi.hoisted(() => ({ rs: { store: new Map() }, settings: { internalAuthDisabled: 'false' } }));
vi.mock('./redis.js', () => ({
  redisClient: {
    async incr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v++; rs.store.set(k, e); return e.v; },
    async decr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v--; rs.store.set(k, e); return e.v; },
    async pExpire(k, ms) { const e = rs.store.get(k); if (e) e.exp = Date.now() + ms; return true; },
    async pTTL(k)        { const e = rs.store.get(k); return e ? (e.exp - Date.now()) : -2; },
    async del(k)         { rs.store.delete(k); return 1; },
    async set(k, v, { NX } = {}) { if (NX && rs.store.has(k)) return null; rs.store.set(k, { v, exp: 0 }); return 'OK'; },
  },
}));
vi.mock('./db.js', () => ({
  query: vi.fn(async sql => (sql.includes("key = 'internal_auth_disabled'") ? { rows: [{ value: settings.internalAuthDisabled }] } : { rows: [] })),
}));
vi.mock('./encryption.js', () => ({ decrypt: value => value }));
vi.mock('./authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 3, windowMs: 60_000 } }));
vi.mock('./authEvents.js', () => ({ logAuthEvent: vi.fn() }));

import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { logAuthEvent } from './authEvents.js';
import { confirmReauth, expiryChoicesFor, reauthFor } from './apiTokenReauth.js';

const SECRET = authenticator.generateSecret();
const TOTP_USER = { id: 'u-totp', username: 'tess', password_hash: bcrypt.hashSync('right', 4), totp_enabled: true, totp_secret: SECRET };
const PASSWORD_USER = { id: 'u-pw', username: 'paul', password_hash: bcrypt.hashSync('right', 4), totp_enabled: false, totp_secret: null };
const SSO_USER = { id: 'u-sso', username: 'sam', password_hash: null, totp_enabled: false, totp_secret: null };
const request = (body, ip = '203.0.113.7') => ({ ip, body });
const count = key => rs.store.get(`rl:${key}`)?.v ?? 0;
const failed = (type, { id, username }, ip = '203.0.113.7') => [type, { userId: id, username, ip, success: false }];

beforeEach(() => {
  rs.store.clear();
  settings.internalAuthDisabled = 'false';
  logAuthEvent.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('which confirmation token creation asks for', () => {
  it('the two-factor code when the user has two-factor on, password or not', async () => {
    expect(await reauthFor(TOTP_USER)).toBe('totp');
    expect(await reauthFor({ ...TOTP_USER, password_hash: null })).toBe('totp');
  });

  it('the password when the user has one and password sign-in is on', async () => {
    expect(await reauthFor(PASSWORD_USER)).toBe('password');
  });

  it('nothing for single sign-on, or when password sign-in is off server-wide', async () => {
    expect(await reauthFor(SSO_USER)).toBe('none');
    settings.internalAuthDisabled = 'true';
    expect(await reauthFor(PASSWORD_USER)).toBe('none');
  });

  it('and without a confirmation a token lasts at most 30 days, never forever', () => {
    expect(expiryChoicesFor('none')).toEqual([7, 30]);
    for (const reauth of ['totp', 'password']) expect(expiryChoicesFor(reauth)).toEqual([7, 30, 90, 365, null]);
  });
});

describe('confirming with the two-factor code', () => {
  const refused = { status: 400, body: { error: 'Confirm with your current two-factor code', reauth: 'totp' } };

  // otplib takes a code only inside its own 30-second step (window 0, as sign-in uses it), so a
  // code made just before a step ends would fail on a busy machine. Hold the clock mid-step.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:10.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('takes the current code, spaces and all', async () => {
    const code = authenticator.generate(SECRET);
    expect(await confirmReauth(request({ totpCode: `${code.slice(0, 3)} ${code.slice(3)}` }), TOTP_USER, 'totp')).toBe(null);
  });

  it('refuses a missing or wrong code, or one with no secret to check it against', async () => {
    const code = authenticator.generate(SECRET);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect(await confirmReauth(request({}), TOTP_USER, 'totp')).toEqual(refused);
    expect(await confirmReauth(request({ totpCode: wrong }), TOTP_USER, 'totp')).toEqual(refused);
    expect(await confirmReauth(request({ password: 'right' }), TOTP_USER, 'totp')).toEqual(refused);
    expect(await confirmReauth(request({ totpCode: code }), { ...TOTP_USER, totp_secret: null }, 'totp')).toEqual(refused);
  });

  it('does not take a code twice, as sign-in does not', async () => {
    const code = authenticator.generate(SECRET);
    expect(await confirmReauth(request({ totpCode: code }), TOTP_USER, 'totp')).toBe(null);
    expect(await confirmReauth(request({ totpCode: code }), TOTP_USER, 'totp')).toEqual(refused);
    expect(rs.store.has(`totp_used:${TOTP_USER.id}:${code}`)).toBe(true);
  });

  it('logs a wrong or replayed code as sign-in logs a failed one, and a missing or right one not at all', async () => {
    const code = authenticator.generate(SECRET);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    await confirmReauth(request({}), TOTP_USER, 'totp');
    await confirmReauth(request({ totpCode: code }), TOTP_USER, 'totp');
    expect(logAuthEvent).not.toHaveBeenCalled();
    await confirmReauth(request({ totpCode: wrong }), TOTP_USER, 'totp');
    await confirmReauth(request({ totpCode: code }), TOTP_USER, 'totp');
    expect(logAuthEvent.mock.calls).toEqual([failed('totp_fail', TOTP_USER), failed('totp_fail', TOTP_USER)]);
  });

  it('allows 5 attempts per 15 minutes on the sign-in challenge\'s own budget', async () => {
    for (let i = 0; i < 5; i++) await confirmReauth(request({ totpCode: '000000' }), TOTP_USER, 'totp');
    expect(count(`totp:${TOTP_USER.id}`)).toBe(5);
    const limited = await confirmReauth(request({ totpCode: authenticator.generate(SECRET) }), TOTP_USER, 'totp');
    expect(limited).toMatchObject({ status: 429, body: { reauth: 'totp' } });
    expect(Number(limited.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

describe('confirming with the password', () => {
  it('takes the right one, and gives its slot in the sign-in budget back', async () => {
    expect(await confirmReauth(request({ password: 'right' }), PASSWORD_USER, 'password')).toBe(null);
    expect(count('auth:203.0.113.7')).toBe(0);
  });

  it('refuses a wrong or missing one, and counts it as a failed sign-in from that address', async () => {
    const refused = { status: 400, body: { error: 'Incorrect password', reauth: 'password' } };
    expect(await confirmReauth(request({ password: 'wrong' }), PASSWORD_USER, 'password')).toEqual(refused);
    expect(await confirmReauth(request({}), PASSWORD_USER, 'password')).toEqual(refused);
    expect(await confirmReauth(request({ password: ['right'] }), PASSWORD_USER, 'password')).toEqual(refused);
    expect(count('auth:203.0.113.7')).toBe(3);
    // The budget is spent, so not even the right one is checked now.
    expect(await confirmReauth(request({ password: 'right' }), PASSWORD_USER, 'password')).toMatchObject({ status: 429, body: { reauth: 'password' } });
  });

  it('logs a wrong one as a failed sign-in, and a missing or right one not at all', async () => {
    await confirmReauth(request({}), PASSWORD_USER, 'password');
    await confirmReauth(request({ password: ['right'] }), PASSWORD_USER, 'password');
    await confirmReauth(request({ password: 'right' }), PASSWORD_USER, 'password');
    expect(logAuthEvent).not.toHaveBeenCalled();
    await confirmReauth(request({ password: 'wrong' }), PASSWORD_USER, 'password');
    expect(logAuthEvent.mock.calls).toEqual([failed('login_fail', PASSWORD_USER)]);
  });

  it('logs no address that is not one, as a proxy may have written it', async () => {
    await confirmReauth(request({ password: 'wrong' }, 'not-an-address'), PASSWORD_USER, 'password');
    await confirmReauth(request({ totpCode: '000000' }, `2001:db8::1%${'x'.repeat(60)}`), TOTP_USER, 'totp');
    expect(logAuthEvent.mock.calls).toEqual([failed('login_fail', PASSWORD_USER, null), failed('totp_fail', TOTP_USER, null)]);
  });

  it('is never checked when no confirmation applies', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    expect(await confirmReauth(request({ password: 'wrong', totpCode: '000000' }), PASSWORD_USER, 'none')).toBe(null);
    expect(compare).not.toHaveBeenCalled();
    expect(rs.store.size).toBe(0);
  });
});
