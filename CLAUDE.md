# MailFlow

A self-hosted, unified webmail client. Dual-licensed: AGPL-3.0, plus a paid commercial
license for use that AGPL does not suit. Node/Express backend, React frontend, PostgreSQL
and Redis, shipped as Docker images.

This file is context for coding agents and for anyone new to the project. It says what
MailFlow is for and how to decide what belongs in it. The mechanics live elsewhere and are
linked rather than repeated.

## What this project is for

**The goal is a rock solid unified webmail client.** Everything else is secondary.

Other features are welcome, but not at the expense of that. A change that makes mail sync,
sending or reading less reliable is not worth the feature it buys, however good the feature
is. When a trade-off appears between "more capable" and "more dependable", dependable wins.

Two consequences worth stating plainly, because they are easy to get wrong:

- **Silent degradation is the worst failure mode here.** Mail that quietly stops syncing, or
  a connection that reconnects forever, looks fine from the outside. Prefer a loud failure,
  a warning in the log, or a health check that asserts the invariant, over something that
  limps.
- **Data loss is unacceptable.** IMAP expunge is permanent. Anything that deletes, moves or
  rewrites a user's mail needs to be sure it is acting on the message it thinks it is.

## Priorities

The roadmap lives on the website in a Now / Next / Later format, with no dates and no
commitments: mailflow.sh/#roadmap. It is deliberately kept in one place, so check it there
rather than trusting a copy.

What does not change with it: polish and stability come first. Bug fixes and reliability
work take precedence over new features.

## Core or plugin?

A feature belongs in a **plugin** if it can do its job through the capability surface in
`backend/src/plugins/api.js`. It belongs in **core** only if it genuinely cannot.

This matters because the boundary is what makes review tractable: a plugin cannot reach
core, the database, the network, or another user's data, and `eslint.plugins-boundary.js`
enforces that in CI. So a plugin PR can be reviewed for whether the feature works, rather
than for whether it could compromise the application.

GTD is the reference plugin. See `backend/src/plugins/README.md` for the surface, the rules
and the directory layout. When it is ambiguous, ask rather than guess.

## Layout

| | Path |
|---|---|
| Backend (Express routes, services) | `backend/src/` |
| IMAP engine | `backend/src/services/imapManager.js` |
| Message parsing and sanitizing | `backend/src/services/messageParser.js`, `emailSanitizer.js` |
| Migrations | `backend/migrations/` |
| Frontend (React) | `frontend/src/` |
| Plugins | `backend/src/plugins/<name>/`, `frontend/src/plugins/<name>/` |
| Desktop and mobile shells | `frontend/packages/` |

## Commands

```bash
cd backend
npm test              # vitest
npm run lint          # eslint, zero warnings allowed
npm run lint:plugins  # plugin import boundary, must be 0 violations

cd frontend
npm test              # node --test
npm run lint
npm run build
```

Both suites and both lints must pass. CI runs them on every PR.

## Working on this codebase

- **Write the test that fails without the fix.** Then revert the fix and confirm it fails.
  A test that passes either way is worse than no test, because it looks like coverage.
- **Keep PRs small and focused.** One fix or feature. Follow-ups go in their own PR rather
  than growing the current one.
- **Open an issue before large work** so the approach can be agreed first. A large PR that
  arrives unannounced may be unmergeable no matter how good it is.
- **Match the surrounding code.** Comments are for the reason behind something surprising,
  not for narrating what the code already says.
- **No half-finished implementations** and no feature flags for hypothetical futures.
- Frontend styling is inline `style={{...}}` objects plus a few shared classes in
  `index.css`. Tailwind is configured but is not the prevailing convention.
- Avoid new dependencies on either side without discussing it first.

See `CONTRIBUTING.md` for commit format, branch naming and PR requirements.

## Paths that need maintainer review

`.github/CODEOWNERS` lists them and GitHub requests review automatically. They are the
places where a mistake is expensive, invisible until much later, or both:

- `emailSanitizer.js`, the boundary that stops untrusted mail executing script
- encryption, sessions and the auth routes
- `backend/migrations/`, which run against live user data and are not reversible in practice
- the connection lifecycle in `imapManager.js`: budgets, IDLE, reconnect, health checks
- workflows, the release script, Dockerfiles and compose, which decide what ships to every
  self-hosted install

## Sharp edges

Things that will bite you if you do not know them. `RELIABILITY_REVIEW.md` and
`COUNT_INTEGRITY_DESIGN.md` carry the detail behind the first two.

- **Counts cannot currently detect that the cache is wrong.** MailFlow never asks IMAP
  `STATUS` how many messages a folder holds; every count is derived from its own rows. So
  "the row count matches the folder count" is a tautology, not evidence of a healthy sync,
  and it has already been misread as reassurance while mail was missing. This is a known
  open design problem, not something to solve casually in passing.
- **Defensive code around connections and errors is not redundant.** An unhandled
  EventEmitter error on the PostgreSQL pool or the WebSocket server takes the process down,
  so those listeners matter even though they look inert. LOGOUT is just another queued IMAP
  command and cannot rescue a hung transport, which is why failed connections are
  force-closed instead. Removing any of it because it looks like it does nothing has
  already been a bug.
- **IMAP IDLE is easy to break silently.** `maxIdleTime` controls how long an IDLE lasts;
  `autoIdleDelay` controls whether one starts at all. A sync interval equal to the arming
  delay cancels IDLE forever, and mail still arrives by polling, so nothing looks wrong. A
  health check now asserts that IDLE-capable accounts are actually idling.
- **Mail is not UTF-8.** Header encoded-words declare their own charset, and plenty of
  senders put raw 8-bit bytes in headers. Decode what the message says, not what is
  convenient.
- **There are two email renderers.** The default renders the sanitized body in an iframe; an
  experimental div-based renderer sits behind `VITE_EMAIL_DIV_RENDER`, default false, and
  compiles away when it is off. Anything touching body rendering has to hold for both.
- **The two attachment extension lists disagree.** `backend/src/services/spamRules.js` and
  `frontend/src/utils/attachmentRisk.js` classify overlapping sets differently. Check both
  before changing either.
- **A host with no provider profile is not a host without quirks.** `providerProfile()` in
  `imapManager.js` has entries for google, yahoo, apple, microsoft and purelymail. Everything
  else, Zoho included, falls through to `generic`.
