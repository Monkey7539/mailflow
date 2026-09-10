// Sender-trust assessment: turns the authentication and spam verdicts the
// mail server already stamped on a message (Authentication-Results,
// ARC-Authentication-Results, rspamd's X-Spamd-Result, SpamAssassin's
// X-Spam-Status) plus a few header heuristics into a small, displayable
// verdict. Pure functions over a lowercase-keyed header map; the route adds
// the DB-derived prior-message count.

const AUTH_RE = /\b(spf|dkim|dmarc)=(pass|fail|softfail|neutral|none|temperror|permerror|policy|bestguesspass)\b/gi;

function orgDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^.*@/, '').split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function addrDomain(addr) {
  const m = /@([^\s>;,]+)/.exec(String(addr || ''));
  return m ? m[1].toLowerCase() : '';
}

// The first header whose value carries spf=/dkim=/dmarc= belongs to the hop
// that actually evaluated the sender. A forwarding hop often stamps only
// arc=pass in Authentication-Results, so fall back to ARC-Authentication-
// Results. The whole value is scanned, not individual lines: a folded header
// puts each method on its own continuation line.
export function parseAuthResults(headers) {
  const candidates = [headers['authentication-results'], headers['arc-authentication-results']]
    .filter(Boolean)
    .map(v => String(v))
    .filter(v => /\b(spf|dkim|dmarc)=/i.test(v));
  const src = candidates[0] || '';
  const out = { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', mailfrom: null, dkimDomain: null };
  if (!src) return out;
  const re = new RegExp(AUTH_RE.source, 'gi');
  const seen = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out[key] = m[2].toLowerCase();
  }
  const mf = /smtp\.mailfrom=([^\s;()]+)/i.exec(src);
  if (mf) out.mailfrom = mf[1].toLowerCase();
  const hd = /header\.d=([^\s;()]+)/i.exec(src);
  if (hd) out.dkimDomain = hd[1].toLowerCase();
  return out;
}

// rspamd: "default: False [2.00 / 15.00];\n SYMBOL(2.00)[detail];\n ..."
export function parseSpamdResult(value) {
  if (!value) return null;
  const head = /\[\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*\]/.exec(value);
  if (!head) return null;
  const symbols = [];
  const re = /([A-Z][A-Z0-9_]+)\((-?\d+(?:\.\d+)?)\)/g;
  let m;
  while ((m = re.exec(value)) !== null) symbols.push({ name: m[1], score: Number(m[2]) });
  return { score: Number(head[1]), threshold: Number(head[2]), symbols, engine: 'rspamd' };
}

// SpamAssassin: "Yes, score=5.2 required=5.0 tests=A,B autolearn=..."
export function parseSpamStatus(value) {
  if (!value) return null;
  const score = /score=(-?\d+(?:\.\d+)?)/i.exec(value);
  const required = /required=(\d+(?:\.\d+)?)/i.exec(value);
  if (!score || !required) return null;
  const tests = /tests=([^\s]+)/i.exec(value);
  const symbols = tests ? tests[1].split(',').filter(Boolean).map(name => ({ name, score: null })) : [];
  return { score: Number(score[1]), threshold: Number(required[1]), symbols, engine: 'spamassassin' };
}

// A multi-word display name that shares no token with the address is the
// classic compromised-account phishing shape ("Clotee Webster"
// <sofia.malheiro@school.example>). Single-word names are skipped — brands and
// first names alone are too ambiguous to judge.
export function displayNameMismatch(name, email) {
  const tokens = String(name || '').toLowerCase().replace(/["']/g, '').split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  if (tokens.length < 2) return false;
  const hay = String(email || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!hay) return false;
  return !tokens.some(t => hay.includes(t));
}

const URGENCY_RE = /\b(action required|urgent|immediately|verify|suspend(?:ed)?|invoice|payment|password|wire|transaction|overdue|final notice)\b/i;
// rspamd symbols that point at spoofing or phishing rather than plain bulk mail.
const SIGNAL_SYMBOL_RE = /PHISH|SPOOF|BAD_REP|FORGED_RECIPIENTS|FROM_NAME_HAS_TITLE|HFILTER_FROM|MALWARE|VIRUS|CLAM|SUSPICIOUS|HACKED|COMPROMISED/i;

export function assessSenderTrust({ headers = {}, fromName = '', fromEmail = '', subject = '', priorCount = null, accountEmail = '' } = {}) {
  const auth = parseAuthResults(headers);
  const spam = parseSpamdResult(headers['x-spamd-result']) || parseSpamStatus(headers['x-spam-status']);
  const flags = [];
  const warn = (id, detail = {}) => flags.push({ id, severity: 'warn', ...detail });
  const info = (id, detail = {}) => flags.push({ id, severity: 'info', ...detail });

  const fromDomain = addrDomain(fromEmail);
  const accountDomain = addrDomain(accountEmail);

  if (displayNameMismatch(fromName, fromEmail)) warn('displayNameMismatch', { name: fromName, email: fromEmail });

  // Envelope sender from a different organization than From. A forwarding
  // hop rewrites the envelope to the recipient's own domain (sieve redirects),
  // which is not the sender's doing — skip that case.
  const envelope = auth.mailfrom || headers['return-path'] || '';
  const envDomain = addrDomain(envelope) || orgDomain(envelope);
  if (envDomain && fromDomain && orgDomain(envDomain) !== orgDomain(fromDomain)
      && orgDomain(envDomain) !== orgDomain(accountDomain)) {
    warn('envelopeMismatch', { from: fromDomain, envelope: envDomain });
  }

  const replyTo = addrDomain(headers['reply-to'] || '');
  if (replyTo && fromDomain && orgDomain(replyTo) !== orgDomain(fromDomain)) {
    warn('replyToMismatch', { replyTo });
  }

  const failed = [];
  if (auth.spf === 'fail' || auth.spf === 'softfail') failed.push('SPF');
  if (auth.dkim === 'fail' || auth.dkim === 'permerror') failed.push('DKIM');
  if (auth.dmarc === 'fail') failed.push('DMARC');
  const authFailed = failed.length > 0;
  if (authFailed) warn('authFailed', { checks: failed.join(', ') });

  let spamHigh = false;
  if (spam) {
    if (spam.score >= spam.threshold) { spamHigh = true; warn('spamHigh', { score: spam.score, threshold: spam.threshold }); }
    else if (spam.score >= spam.threshold * 0.4) warn('spamElevated', { score: spam.score, threshold: spam.threshold });
    const signals = spam.symbols.filter(s => SIGNAL_SYMBOL_RE.test(s.name) && (s.score == null || s.score > 0)).map(s => s.name);
    if (signals.length) warn('phishSymbols', { symbols: signals.join(', ') });
  }

  const firstTime = priorCount === 0;
  if (firstTime) info('firstTimeSender');

  const unfamiliar = firstTime || flags.some(f => f.id === 'displayNameMismatch');
  if (unfamiliar && URGENCY_RE.test(subject || '')) warn('urgentUnfamiliar');

  const warnCount = flags.filter(f => f.severity === 'warn').length;
  const level = (authFailed && auth.dmarc === 'fail') || spamHigh || warnCount >= 2
    ? 'danger'
    : warnCount ? 'caution' : 'ok';

  return {
    level,
    auth: { spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, dkimDomain: auth.dkimDomain },
    spam: spam ? { score: spam.score, threshold: spam.threshold, engine: spam.engine } : null,
    flags,
  };
}
