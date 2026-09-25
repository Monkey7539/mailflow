// Backing off when the server rejects the credentials.
//
// A wrong password does not fix itself, but MailFlow retried one every 92 seconds: a dev
// Yahoo account logged 627 failed logins in 16 hours. The refusal ladder tops out at 15
// minutes, which is right for a provider that is merely busy and far too eager for one
// that is telling us the password is wrong. That is how a client gets an account locked
// or a server IP flagged.

import { describe, it, expect, vi } from 'vitest';

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

import { isAuthFailure, authCooldownMs, connectCooldownMs, isConnectionRefusal } from './imapManager.js';

describe('isAuthFailure', () => {
  it.each([
    // Captured from a live Yahoo account on the dev instance, via extractImapError.
    '[AUTHENTICATIONFAILED] AUTHENTICATE Invalid credentials',
    'Authentication failed',
    'Invalid credentials',
    'LOGIN failed',
    'Invalid password',
    'invalid user or password',
    '[AUTHORIZATIONFAILED] Authorization failed',
    // The response code ALONE, with no other giveaway wording. Without this the code could
    // be dropped from the pattern and every other case would still pass, because they all
    // happen to contain phrases like "invalid credentials" too.
    '[AUTHENTICATIONFAILED] Server said no',
  ])('flags credentials the server rejected: %s', (msg) => {
    expect(isAuthFailure(msg)).toBe(true);
  });

  it.each([
    // These must keep the SHORT refusal ladder: they are transient and recover in seconds.
    '[LIMIT] CAPABILITY Rate limit hit.',
    'Too many simultaneous connections',
    'Connection not available',
    'socket hang up',
    'ECONNRESET',
    'Folder status connect timeout (25000ms)',
    '',
    null,
    undefined,
  ])('does not flag a non-auth failure: %s', (msg) => {
    expect(isAuthFailure(msg)).toBe(false);
  });

  it('never classes the same string as both auth and a plain refusal', () => {
    // The connect path checks auth first, so an overlap would silently pick the wrong
    // ladder. Nothing we back off on should answer to both.
    const strings = [
      '[AUTHENTICATIONFAILED] AUTHENTICATE Invalid credentials',
      '[LIMIT] CAPABILITY Rate limit hit.',
      'Too many simultaneous connections',
    ];
    for (const s of strings) {
      expect(isAuthFailure(s) && isConnectionRefusal(s)).toBe(false);
    }
  });
});

describe('authCooldownMs', () => {
  it('starts at 5 minutes, not the refusal ladder\'s 30 seconds', () => {
    expect(authCooldownMs(1)).toBe(5 * 60 * 1000);
    expect(authCooldownMs(1)).toBeGreaterThan(connectCooldownMs(1));
  });

  it('doubles, and caps at 6 hours', () => {
    expect(authCooldownMs(2)).toBe(10 * 60 * 1000);
    expect(authCooldownMs(3)).toBe(20 * 60 * 1000);
    expect(authCooldownMs(50)).toBe(6 * 60 * 60 * 1000);
  });

  it('turns 16 hours of a wrong password into roughly ten attempts, not six hundred', () => {
    // The observed failure: 627 logins in 16 hours. Walk the ladder over the same window.
    let elapsed = 0, attempts = 0;
    while (elapsed < 16 * 60 * 60 * 1000) {
      attempts += 1;
      elapsed += authCooldownMs(attempts);
    }
    expect(attempts).toBeLessThan(15);
    expect(attempts).toBeGreaterThan(5);
  });

  it('is never zero or negative for a degenerate count', () => {
    for (const n of [0, -1, NaN]) expect(authCooldownMs(n)).toBeGreaterThan(0);
  });
});
