import { describe, expect, it } from 'vitest';
import { assessSenderTrust, parseAuthResults, parseSpamdResult, parseSpamStatus, displayNameMismatch } from './senderTrust.js';

// Modeled on a real compromised-Google-Workspace phish: the forwarding hop's
// Authentication-Results carries only arc=pass; the original verdicts live in
// ARC-Authentication-Results. SPF/DKIM pass because Google really sent it.
const PHISH_HEADERS = {
  'return-path': '<info@example.org>',
  'authentication-results': 'mx.example.org;\n\tarc=pass ("example.org:s=dkim:i=1")',
  'arc-authentication-results': 'i=1;\n\tmx.example.org;\n\tdkim=pass header.d=school-net.20251104.gappssmtp.com header.s=20251104 header.b=abc;\n\tspf=pass (mx.example.org: domain of sofia.cb.malheiro.35627@school.net designates 209.85.221.41 as permitted sender) smtp.mailfrom=sofia.cb.malheiro.35627@school.net;\n\tdmarc=none',
  'x-spamd-result': 'default: False [2.00 / 15.00];\n\tBAD_REP_POLICIES(2.00)[];\n\tMIME_GOOD(-0.10)[multipart/mixed,text/plain];\n\tFORGED_SENDER(0.00)[sofia.cb.malheiro.35627@school.net,info@example.org];\n\tHAS_ATTACHMENT(0.00)[]',
};

describe('parseAuthResults', () => {
  it('prefers the hop that evaluated spf/dkim over a forwarding hop that only stamped arc', () => {
    const a = parseAuthResults(PHISH_HEADERS);
    expect(a).toMatchObject({ spf: 'pass', dkim: 'pass', dmarc: 'none', mailfrom: 'sofia.cb.malheiro.35627@school.net' });
    expect(a.dkimDomain).toBe('school-net.20251104.gappssmtp.com');
  });

  it('reports unknown when nothing evaluated the sender', () => {
    expect(parseAuthResults({})).toMatchObject({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' });
  });
});

describe('spam verdict parsers', () => {
  it('reads rspamd score, threshold and scored symbols', () => {
    const s = parseSpamdResult(PHISH_HEADERS['x-spamd-result']);
    expect(s).toMatchObject({ score: 2, threshold: 15, engine: 'rspamd' });
    expect(s.symbols.find(x => x.name === 'BAD_REP_POLICIES').score).toBe(2);
  });

  it('reads SpamAssassin status', () => {
    expect(parseSpamStatus('Yes, score=6.3 required=5.0 tests=HTML_MESSAGE,URIBL_BLACK autolearn=no'))
      .toMatchObject({ score: 6.3, threshold: 5, engine: 'spamassassin' });
    expect(parseSpamStatus('')).toBeNull();
  });
});

describe('displayNameMismatch', () => {
  it('flags a person name that shares nothing with the address', () => {
    expect(displayNameMismatch('Clotee Webster', 'sofia.cb.malheiro.35627@school.net')).toBe(true);
  });
  it('accepts names echoed in the local part or the domain, and skips single words', () => {
    expect(displayNameMismatch('Marc Rothschild', 'marc@bondsports.co')).toBe(false);
    expect(displayNameMismatch('Wells Fargo Bank', 'charles.e.scott@wellsfargo.com')).toBe(false);
    expect(displayNameMismatch('Steam', 'noreply@steampowered.com')).toBe(false);
    expect(displayNameMismatch('', 'x@y.z')).toBe(false);
  });
});

describe('assessSenderTrust', () => {
  it('rates the compromised-account phish as danger without any auth failure', () => {
    const t = assessSenderTrust({
      headers: PHISH_HEADERS,
      fromName: 'Clotee Webster',
      fromEmail: 'sofia.cb.malheiro.35627@school.net',
      subject: 'Action required: Access now transaction record for Invoice #Transaction',
      priorCount: 0,
      accountEmail: 'marty@example.org',
    });
    expect(t.level).toBe('danger');
    expect(t.auth).toMatchObject({ spf: 'pass', dkim: 'pass', dmarc: 'none' });
    const ids = t.flags.map(f => f.id);
    expect(ids).toEqual(expect.arrayContaining(['displayNameMismatch', 'phishSymbols', 'urgentUnfamiliar', 'firstTimeSender']));
    // The forwarding hop rewrote Return-Path to the recipient's own domain — not an envelope mismatch.
    expect(ids).not.toContain('envelopeMismatch');
    expect(t.flags.find(f => f.id === 'phishSymbols').symbols).toBe('BAD_REP_POLICIES');
  });

  it('rates a normal known correspondent as ok', () => {
    const t = assessSenderTrust({
      headers: { 'authentication-results': 'mx; dkim=pass header.d=bondsports.co; spf=pass smtp.mailfrom=marc@bondsports.co; dmarc=pass' },
      fromName: 'Marc Rothschild', fromEmail: 'marc@bondsports.co',
      subject: 'Re: USAH technology connection', priorCount: 12, accountEmail: 'marty@example.org',
    });
    expect(t.level).toBe('ok');
    expect(t.flags).toEqual([]);
  });

  it('flags a reply-to hijack and a foreign envelope, two warnings making it danger', () => {
    const t = assessSenderTrust({
      headers: {
        'authentication-results': 'mx; spf=pass smtp.mailfrom=bounce@bulk-sender.example; dkim=pass; dmarc=none',
        'reply-to': 'Accounts <pay@other-domain.example>',
      },
      fromName: 'Acme Billing', fromEmail: 'billing@acme.example', subject: 'Statement', priorCount: 3, accountEmail: 'marty@example.org',
    });
    expect(t.flags.map(f => f.id)).toEqual(expect.arrayContaining(['replyToMismatch', 'envelopeMismatch']));
    expect(t.level).toBe('danger');
  });

  it('treats a DMARC failure and an over-threshold spam score as danger', () => {
    const t = assessSenderTrust({
      headers: {
        'authentication-results': 'mx; spf=fail smtp.mailfrom=x@fake.example; dkim=fail; dmarc=fail',
        'x-spam-status': 'Yes, score=7.1 required=5.0 tests=URIBL_BLACK',
      },
      fromName: 'Bank', fromEmail: 'x@fake.example', subject: 'hi', priorCount: 5,
    });
    expect(t.level).toBe('danger');
    expect(t.flags.map(f => f.id)).toEqual(expect.arrayContaining(['authFailed', 'spamHigh']));
    expect(t.spam).toMatchObject({ score: 7.1, threshold: 5, engine: 'spamassassin' });
  });

  it('marks a first-time but otherwise clean sender as ok with an info flag', () => {
    const t = assessSenderTrust({
      headers: { 'authentication-results': 'mx; spf=pass smtp.mailfrom=new@vendor.example; dkim=pass; dmarc=pass' },
      fromName: 'Pat Vendor', fromEmail: 'pat@vendor.example', subject: 'Introduction', priorCount: 0,
    });
    expect(t.level).toBe('ok');
    expect(t.flags).toEqual([{ id: 'firstTimeSender', severity: 'info' }]);
  });
});
