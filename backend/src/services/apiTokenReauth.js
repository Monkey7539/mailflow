import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { redisClient } from './redis.js';
import { consume, release, reset } from './rateLimiter.js';
import { authLimiterConfig } from './authLimiter.js';
import { logAuthEvent } from './authEvents.js';
import { EXPIRY_CHOICES, normalizeIp } from './apiTokens.js';

// Confirming who is at the browser before an API token is created (#617 left this open for the
// maintainer). A token can do what its scopes allow for as long as it lasts, past sign-out and
// past the session, so an unlocked browser must not be able to mint one quietly. This module is
// the whole of that rule; routes/apiTokens.js only asks it.
//
// - 'totp' when the user has two-factor on: their current code, checked as the sign-in
//   challenge checks it (routes/auth.js), with the same replay guard and totp:<uid> limit.
// - 'password' when they have one and password sign-in is on: counted against the sign-in
//   budget auth:<ip>. When password sign-in is off, no password is checked at all, as at sign-in:
//   a server that takes no passwords must not say whether one is right.
// - 'none' otherwise (single sign-on only). Nothing can be asked, so such a token lasts at most
//   30 days and never "no expiry".
// Under mfa_enforcement=required a user without TOTP signs in with an emailed code, but confirms
// here with the password only.
//
// A wrong code or password is logged as sign-in logs one (totp_fail, login_fail), so guessing from
// inside a session shows in the admin's security log too.
export async function reauthFor(user) {
  if (user.totp_enabled) return 'totp';
  if (user.password_hash && !(await passwordSignInDisabled())) return 'password';
  return 'none';
}

const UNCONFIRMED_EXPIRY_CHOICES = [7, 30];

export function expiryChoicesFor(reauth) {
  return reauth === 'none' ? UNCONFIRMED_EXPIRY_CHOICES : EXPIRY_CHOICES;
}

async function passwordSignInDisabled() {
  const { rows } = await query("SELECT value FROM system_settings WHERE key = 'internal_auth_disabled'");
  return rows[0]?.value === 'true';
}

// null once confirmed, or { status, body, headers } to answer with. Never 401: the web client
// takes a 401 for an expired session and signs out.
export async function confirmReauth(req, user, reauth) {
  if (reauth === 'totp') return confirmTotp(req, user, req.body?.totpCode);
  if (reauth === 'password') return confirmPassword(req, user, req.body?.password);
  return null;
}

const TOTP_WINDOW_MS = 15 * 60 * 1000;

// Only for an answer that was given and is wrong: a missing one guesses nothing.
const logWrongAnswer = (eventType, req, user) => logAuthEvent(eventType, {
  userId: user.id, username: user.username, ip: normalizeIp(req.ip), success: false,
});

async function confirmTotp(req, user, totpCode) {
  const limitKey = `totp:${user.id}`;
  const limit = await consume(limitKey, 5, TOTP_WINDOW_MS);
  if (limit.limited) return tooManyAttempts('totp', limit.resetMs);
  const wrong = { status: 400, body: { error: 'Confirm with your current two-factor code', reauth: 'totp' } };
  const code = String(totpCode ?? '').replace(/\s/g, '');
  if (!code) return wrong;
  if (!user.totp_secret || !authenticator.verify({ token: code, secret: decrypt(user.totp_secret) })) {
    logWrongAnswer('totp_fail', req, user);
    return wrong;
  }
  const firstUse = await redisClient.set(`totp_used:${user.id}:${code}`, '1', { NX: true, EX: 90 });
  if (!firstUse) {
    logWrongAnswer('totp_fail', req, user);
    return wrong;
  }
  await reset(limitKey);
  return null;
}

async function confirmPassword(req, user, password) {
  const limitKey = `auth:${req.ip}`;
  const limit = await consume(limitKey, authLimiterConfig.maxRequests, authLimiterConfig.windowMs);
  if (limit.limited) return tooManyAttempts('password', limit.resetMs);
  const wrong = { status: 400, body: { error: 'Incorrect password', reauth: 'password' } };
  if (typeof password !== 'string' || password === '') return wrong;
  if (!(await bcrypt.compare(password, user.password_hash))) {
    logWrongAnswer('login_fail', req, user);
    return wrong;
  }
  // Only the right password gives its slot back, as for CardDAV.
  await release(limitKey);
  return null;
}

const tooManyAttempts = (reauth, resetMs) => ({
  status: 429,
  headers: { 'Retry-After': String(Math.max(1, Math.ceil(resetMs / 1000))) },
  body: { error: 'Too many attempts. Try again later.', reauth },
});
