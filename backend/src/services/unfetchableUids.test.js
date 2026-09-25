// Breaking the integrity-check / backfill loop.
//
// Production iCloud account: five UIDs the server lists in both the flag FETCH and the UID
// SEARCH, but returns nothing for when the backfill asks. The integrity check counted them
// as a gap, scheduled a backfill, the backfill saved nothing, and the next check found the
// same gap. 35 cycles in five hours, forever:
//
//   Backfill: 5 missing of 22892 (22887 already in DB)
//   Backfill: 5/5 UID candidates processed; 0 messages saved

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import {
  recordUnfetchable, suppressedUids, clearUnfetchable, hasRealGap,
  UNFETCHABLE_ATTEMPT_THRESHOLD, UNFETCHABLE_RETRY_AFTER_MS,
} from './unfetchableUids.js';
import { query } from './db.js';

beforeEach(() => vi.clearAllMocks());

describe('hasRealGap', () => {
  const set = (...v) => new Set(v);

  it('reports a gap for a UID the server has and we do not', () => {
    expect(hasRealGap(set(1, 2, 3), set(1, 2), set())).toBe(true);
  });

  it('stops reporting a gap once the missing UID is written off', () => {
    // This single assertion is the loop breaker.
    expect(hasRealGap(set(1, 2, 3), set(1, 2), set(3))).toBe(false);
  });

  it('reproduces the reported shape: five refused UIDs in a 22,892 message mailbox', () => {
    const server = new Set(Array.from({ length: 22892 }, (_, i) => i + 1));
    const ghosts = [900, 901, 902, 903, 904];
    const local = new Set([...server].filter(u => !ghosts.includes(u)));

    expect(hasRealGap(server, local, new Set())).toBe(true);        // today: loops forever
    expect(hasRealGap(server, local, new Set(ghosts))).toBe(false); // written off: settles
  });

  it('still reports a real gap when only some missing UIDs are written off', () => {
    // Writing off ghosts must never mask genuinely un-ingested mail arriving alongside them.
    expect(hasRealGap(set(1, 2, 3, 4), set(1), set(2, 3))).toBe(true);
  });

  it('is false for an empty mailbox and for a mailbox we fully hold', () => {
    expect(hasRealGap(set(), set(), set())).toBe(false);
    expect(hasRealGap(set(1, 2), set(1, 2), set())).toBe(false);
  });
});

describe('recordUnfetchable', () => {
  it('does not touch the database for an empty list', async () => {
    await recordUnfetchable('acct', 'INBOX', [], 1);
    expect(query).not.toHaveBeenCalled();
  });

  it('increments the attempt count on a repeat miss rather than inserting again', async () => {
    query.mockResolvedValue({ rows: [] });
    await recordUnfetchable('acct', 'INBOX', [900, 901], 12345);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT .*DO UPDATE/s);
    expect(sql).toMatch(/attempts/);
    expect(params[0]).toBe('acct');
    expect(params[2]).toEqual(['900', '901']);   // bigint[] wants strings
    expect(params[3]).toBe('12345');
  });

  it('restarts the count when uidvalidity changed, since those are different messages', async () => {
    query.mockResolvedValue({ rows: [] });
    await recordUnfetchable('acct', 'INBOX', [900], 999);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/uid_validity IS DISTINCT FROM EXCLUDED\.uid_validity/);
    expect(sql).toMatch(/THEN 1/);
  });
});

describe('suppressedUids', () => {
  it('only suppresses UIDs refused at least the threshold number of times', async () => {
    query.mockResolvedValue({ rows: [{ uid: '900' }] });
    const got = await suppressedUids('acct', 'INBOX', 5);
    const [sql, params] = query.mock.calls[0];
    expect(params[2]).toBe(UNFETCHABLE_ATTEMPT_THRESHOLD);
    expect(sql).toMatch(/attempts >= /);
    expect(got).toEqual(new Set([900]));
  });

  it('ignores entries older than the retry window, so a fixed server is retried', async () => {
    query.mockResolvedValue({ rows: [] });
    await suppressedUids('acct', 'INBOX', 5);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/last_attempt_at > now\(\)/);
    expect(params[3]).toBe(String(UNFETCHABLE_RETRY_AFTER_MS));
  });

  it('scopes to the current uidvalidity, so a renumbered mailbox suppresses nothing stale', async () => {
    query.mockResolvedValue({ rows: [] });
    await suppressedUids('acct', 'INBOX', 777);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/uid_validity = \$5/);
    expect(params[4]).toBe('777');
    // The predicate must require an exact epoch match. It previously also matched when
    // either side was NULL, which made those rows wildcards across every generation. Checked
    // against a live Postgres with rows at epochs 1000 and 2000: the old predicate suppressed
    // both, this one suppresses only the row whose epoch is current. A suppressed UID from a
    // dead epoch would mean silently never fetching whatever real message reused that number.
    expect(sql).not.toMatch(/uid_validity IS NULL/);
    expect(sql).not.toMatch(/\$5::bigint IS NULL/);
  });

  it('suppresses nothing when the current uidvalidity is unknown', async () => {
    // Matching everything is the failure mode above, so an unknown epoch must suppress
    // nothing rather than everything. Re-requesting a ghost costs one wasted FETCH.
    const got = await suppressedUids('acct', 'INBOX', null);
    expect(got).toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });

  it('records nothing when the server did not report a uidvalidity', async () => {
    // A record with no epoch cannot be scoped, so it would behave as a wildcard forever.
    await recordUnfetchable('acct', 'INBOX', [900], null);
    expect(query).not.toHaveBeenCalled();
  });

  it('gives up suppressing after a week, which is more than three attempts apart', () => {
    // A guard on the constants themselves: a retry window shorter than the time it takes to
    // reach the threshold would mean nothing is ever suppressed and the loop returns.
    expect(UNFETCHABLE_RETRY_AFTER_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(UNFETCHABLE_ATTEMPT_THRESHOLD).toBeGreaterThan(1);
  });
});

describe('clearUnfetchable', () => {
  it('forgets a UID that finally arrived, so its count restarts', async () => {
    query.mockResolvedValue({ rows: [] });
    await clearUnfetchable('acct', 'INBOX', [900]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/^DELETE FROM unfetchable_uids/);
    expect(params[2]).toEqual(['900']);
  });

  it('does nothing for an empty list', async () => {
    await clearUnfetchable('acct', 'INBOX', []);
    expect(query).not.toHaveBeenCalled();
  });
});
