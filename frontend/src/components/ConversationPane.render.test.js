// Render test for the conversation pane.
//
// The behavior that matters, and that a util test cannot show, is that a thread renders one
// card per message with only the newest open, and that opening another card mounts a second
// body. That is the whole point of the Gmail-style view: bodies are expensive, so only what
// the reader has opened is rendered.
//
// Same loader hooks as MessagePane.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed because a real i18n instance would test i18next.

import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const THREAD = [
  { id: 'm1', account_id: 'acct', folder: 'INBOX', message_id: '<1@x>', subject: 'Welcome', from_email: 'a@x.z', from_name: 'Ana', date: '2026-01-01T10:00:00Z', is_read: true, snippet: 'first' },
  { id: 'm2', account_id: 'acct', folder: '[Gmail]/Sent Mail', message_id: '<2@x>', subject: 'Re: Welcome', from_email: 'me@x.z', from_name: 'Me', date: '2026-01-02T10:00:00Z', is_read: true, snippet: 'my reply' },
  { id: 'm3', account_id: 'acct', folder: 'INBOX', message_id: '<3@x>', subject: 'Re: Welcome', from_email: 'a@x.z', from_name: 'Ana', date: '2026-01-03T10:00:00Z', is_read: false, snippet: 'newest' },
];
const bodyRequests = [];
const bulkReads = [];
let blockImages = false;
let textOnly = false;
// What every fetched body carries as its attachment list; a test fills it to see the strip.
const bodyAttachments = [];
const remoteBodyRequests = [];
let threadResponse = THREAD;
let actionRequests = [];
let folderRequests = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/mail/thread?')) return { ok: true, status: 200, json: async () => ({ messages: threadResponse }) };
  if (u.includes('/mail/messages/bulk-read')) {
    bulkReads.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  }
  if (/\/mail\/messages\/bulk-(archive|delete|move)$/.test(u)) {
    actionRequests.push({ url: u, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  }
  const folderAccount = /\/accounts\/([^/]+)\/folders$/.exec(u)?.[1];
  if (folderAccount) {
    folderRequests.push(folderAccount);
    return { ok: true, status: 200, json: async () => [{ path: 'Projects', name: 'Projects' }] };
  }
  const id = /\/messages\/([^/]+)\/body/.exec(u)?.[1];
  if (id) {
    bodyRequests.push(id);
    const remote = u.includes('remoteImages=1');
    if (remote) remoteBodyRequests.push(id);
    if (textOnly) return { ok: true, status: 200, json: async () => ({ html: '', text: `plain body of ${id}`, attachments: [] }) };
    return { ok: true, status: 200, json: async () => ({ html: `<p>body of ${id}</p>`, text: '', attachments: bodyAttachments, hasBlockedRemoteImages: blockImages && !remote }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ConversationPane = (await import('./ConversationPane.jsx')).default;
const ReadingPane = (await import('./ReadingPane.jsx')).default;
const { useStore } = await import('../store/index.js');
const { registerCollector } = await import('../plugins/registry.js');
const { bodyCache } = await import('../utils/bodyCache.js');
// Each test serves its own body for the same message ids: start each without the last one's.
beforeEach(() => bodyCache.clear());
const { shortcutBus } = await import('../utils/shortcutBus.js');
const { api } = await import('../utils/api.js');
const { useGtdTriage } = await import('../hooks/useGtdTriage.js');

let root;
before(() => { root = createRoot(document.getElementById('root')); });
after(async () => { await React.act(async () => root.unmount()); });

const cards = () => document.querySelectorAll('[aria-expanded]');
const openCards = () => document.querySelectorAll('[aria-expanded="true"]');

describe('conversation pane', () => {
  // These cards show HTML emails as sent. Dark email bodies (#228), on by default, are covered
  // by the plain-text card below and by MessagePane's tests.
  before(async () => {
    const { useStore } = await import('../store/index.js');
    useStore.setState({ darkEmailBodies: false });
  });

  test('renders one card per message with only the newest open', async () => {
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { threadId: '<1@x>', folder: 'INBOX' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    assert.equal(cards().length, 3, 'every message in the thread gets a card');
    assert.equal(openCards().length, 1, 'only one card opens, so only one body is rendered');
    // Sent replies belong in the conversation, which is why the thread endpoint crosses folders.
    assert.match(document.getElementById('root').innerHTML, /Me/, 'the sent reply appears in the thread');
  });

  test('fills the reading area instead of shrinking to fit its contents', async () => {
    // The reading area is a flex row. Without flex:1 the pane is sized shrink-to-fit, so
    // it was as narrow as whatever was open: a sliver for collapsed headers, the width of
    // the newsletter for an expanded one, resizing as the reader clicked. minWidth:0 stops
    // a wide email pushing it past its share. jsdom does no layout, so this asserts the
    // properties themselves, which is what a regression would remove.
    const pane = document.querySelector('#root > div');
    // flexGrow rather than the flex shorthand, which is stored expanded ("1 1 0%").
    assert.equal(pane.style.flexGrow, '1', 'the pane grows to fill the reading area');
    assert.equal(pane.style.minWidth, '0px', 'and a wide email cannot stretch it');
    assert.equal(pane.style.overflow, 'hidden', 'and it shrinks to its share of a column');
  });

  test('the opened message actually renders its body, not a permanent skeleton', async () => {
    // The request going out is not enough. An earlier version listed the loading flag in
    // the fetch effect's dependencies, so setLoading re-ran the effect and its cleanup
    // cancelled the request it had just started: the body arrived and was thrown away,
    // and every card sat on the skeleton forever. Only asserting the rendered body catches
    // that, which is why this asserts the frame and not the fetch.
    const html = document.getElementById('root').innerHTML;
    assert.ok(/<iframe/.test(html), 'the opened message rendered a body frame');
    assert.ok(!/skeleton-line/.test(html), 'and is no longer showing the loading skeleton');
  });

  test('the body frame sits in the same white padded card the reading pane uses', async () => {
    // The frame's stylesheet zeroes body margin and padding, so an email's only gutter is
    // whatever the surrounding card provides. The reading pane wraps its frame in a white
    // .msg-card with a 16px gutter; the conversation card put the frame straight on the
    // dark card, and hand-typed mail (no margins of its own) rendered flush against the
    // frame edge. Asserting the wrapper — not just the frame — is what makes this fail if
    // the card or its padding is removed again.
    const frame = document.querySelector('iframe');
    const card = frame?.closest('.msg-card');
    assert.ok(card, 'the body frame is wrapped in a message card');
    assert.equal(card.style.padding, '14px 16px 12px', 'with the reading pane gutter');
    assert.equal(card.style.background, 'white', 'on the same white card');
  });

  test('only the opened message fetches a body', async () => {
    // A collapsed card must cost nothing: no request, no frame, no document.
    assert.deepEqual(bodyRequests, ['m3'], 'exactly the newest message was fetched');
  });

  test('the message that opens is marked read', async () => {
    // m3 is the unread one, and it is the card that opens on arrival. Opening a
    // conversation has to clear its unread state the same way opening a single
    // message does, or the badge never goes down.
    assert.deepEqual(bulkReads, [{ ids: ['m3'], read: true }], 'the newest, unread message was marked read');
  });

  test('opening another card renders a second body', async () => {
    const collapsed = document.querySelector('[aria-expanded="false"]');
    await React.act(async () => { collapsed.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    assert.equal(openCards().length, 2, 'two messages can be open at once');
    assert.equal(bodyRequests.length, 2, 'the newly opened message fetched its own body');
    // The card that just opened was already read, so it must not send a second
    // mark-read and decrement a badge that was never counting it.
    assert.equal(bulkReads.length, 1, 'expanding an already-read message marks nothing');
  });

  test('picking a different message in the same thread opens that message', async () => {
    // Selecting another message in an open thread does not change threadId, so the pane
    // re-rendered with identical props and nothing happened: clicking a message in the
    // list looked like a dead click. m2 is the one still collapsed at this point.
    const opened = () => [...openCards()].map(c => c.closest('[data-message-id]')?.dataset.messageId);
    assert.ok(!opened().includes('m2'), 'm2 starts collapsed');

    await React.act(async () => {
      root.render(React.createElement(ConversationPane, {
        threadId: '<1@x>', folder: 'INBOX', selectedMessageId: 'm2',
      }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    assert.ok(opened().includes('m2'), 'the message the reader picked is now open');
  });

  test('collapsing and reopening does not refetch', async () => {
    const before = bodyRequests.length;
    const open = document.querySelector('[aria-expanded="true"]');
    await React.act(async () => { open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    assert.equal(bodyRequests.length, before, 'a body already loaded is kept');
  });

  test('an opened card renders the attachments its body carries (#634)', async (t) => {
    // The body response already lists the files; before the strip the card dropped that
    // list, so a grouped thread gave no way to see or download an attachment at all.
    bodyAttachments.push(
      { part: '2', filename: 'invoice.pdf', type: 'application/pdf', size: 12345 },
      { part: '3', filename: 'notes.txt', type: 'text/plain', size: 678 },
    );
    t.after(() => { bodyAttachments.length = 0; });
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { key: 'attachments', threadId: '<1@x>', folder: 'INBOX', selectedMessageId: 'm1' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const opened = document.querySelector('[data-message-id="m1"]');
    assert.match(opened.textContent, /message\.attachment/, 'the strip renders under its heading');
    assert.match(opened.textContent, /invoice\.pdf/, 'the first file shows as a chip');
    assert.match(opened.textContent, /notes\.txt/, 'and so does the second');
    assert.match(opened.textContent, /12 KB/, 'with its size');
    assert.match(opened.textContent, /message\.downloadAll/, 'and "Download all" for more than one');
    assert.ok(
      !document.querySelector('[data-message-id="m2"]').textContent.includes('invoice.pdf'),
      'a collapsed card, whose body was never fetched, shows none');
  });

  test('a plain-text message stays translatable under the translate="no" UI', async (t) => {
    // See index.html: <body> is translate="no", and a plain-text body renders in the main
    // document, so it has to opt back in or the browser cannot translate it.
    textOnly = true;
    t.after(() => { textOnly = false; });
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { key: 'text-only', threadId: '<1@x>', folder: 'INBOX', selectedMessageId: 'm1' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const body = [...document.querySelectorAll('div')].find(el => el.textContent === 'plain body of m1');
    assert.ok(body, 'the plain-text body is rendered');
    assert.equal(body.getAttribute('translate'), 'yes');
  });

  test('an HTML message stays translatable under the translate="no" UI', async () => {
    // Chrome's translator carries the page's translate="no" into the same-origin frame an HTML
    // body renders in, so the email has to opt back in inside its own document.
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { key: 'html-body', threadId: '<1@x>', folder: 'INBOX', selectedMessageId: 'm1' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const frame = [...document.querySelectorAll('iframe')].find(f => /body of m1/.test(f.getAttribute('srcdoc') ?? ''));
    assert.ok(frame, 'the HTML body is rendered in a frame');
    const text = new dom.window.DOMParser().parseFromString(frame.getAttribute('srcdoc'), 'text/html').querySelector('p');
    assert.ok(text, 'the HTML body reaches the frame');
    assert.equal(text.closest('[translate]')?.getAttribute('translate'), 'yes');
  });

  // #228: plain text follows a dark theme, and each card can switch back to its original colors.
  test('a plain-text card in a dark theme can be switched to its original colors and back', async (t) => {
    const { useStore } = await import('../store/index.js');
    textOnly = true;
    useStore.setState({ theme: 'dark' });
    t.after(() => { textOnly = false; });
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { key: 'text-dark', threadId: '<1@x>', folder: 'INBOX', selectedMessageId: 'm1' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const body = () => [...document.querySelectorAll('div')].find(el => el.textContent === 'plain body of m1');
    const button = label => [...document.querySelectorAll('button')].find(b => b.textContent === label);
    assert.equal(body().style.background, '', 'themed, as before');
    await React.act(async () => { button('message.showOriginal').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.equal(body().style.background, 'white');
    await React.act(async () => { button('message.showDark').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.equal(body().style.background, '');
  });

  test('selected conversation card handles image and unsubscribe shortcuts', async (t) => {
    blockImages = true;
    THREAD[2].list_unsubscribe = '<https://example.invalid/unsubscribe>';
    const unsubscribed = [];
    const oldUnsubscribe = api.unsubscribeMessage;
    api.unsubscribeMessage = async id => { unsubscribed.push(id); return { type: 'one-click' }; };
    t.after(() => { api.unsubscribeMessage = oldUnsubscribe; blockImages = false; delete THREAD[2].list_unsubscribe; });
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { key: 'hotkey-card', threadId: '<1@x>', folder: 'INBOX', selectedMessageId: 'm3' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    await React.act(async () => { shortcutBus.emit('loadRemoteImages'); shortcutBus.emit('unsubscribe'); await new Promise(r => setTimeout(r, 50)); });
    assert.deepEqual(remoteBodyRequests, ['m3']);
    assert.deepEqual(unsubscribed, ['m3']);
  });
});

// Per-message actions and printing in the conversation view (#521).
describe('conversation actions', () => {
  const requests = [];
  let realFetch;
  let printWin;
  // Set by a test to hold the next star request until it says how the server answers.
  let starAnswer = null;
  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      requests.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
      if (starAnswer && String(url).endsWith('/star')) {
        const ok = await starAnswer;
        return ok
          ? { ok: true, status: 200, json: async () => ({ ok: true }) }
          : { ok: false, status: 500, json: async () => ({ error: 'IMAP store failed' }) };
      }
      if (String(url).includes('/ai/status')) return { ok: true, status: 200, json: async () => ({ enabled: true, features: { summarize: true } }) };
      if (String(url).includes('/ai/chat')) {
        const sse = 'data: {"choices":[{"delta":{"content":"Short "}}]}\n\ndata: {"choices":[{"delta":{"content":"summary."}}]}\n\ndata: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return realFetch(url, opts);
    };
    dom.window.open = () => {
      printWin = {
        writes: [], closed: false, printed: 0,
        document: { open() { printWin.writes.length = 0; }, write(h) { printWin.writes.push(h); }, close() {} },
        focus() {}, print() { printWin.printed++; },
      };
      return printWin;
    };
    globalThis.window.open = dom.window.open;
  });
  after(() => { globalThis.fetch = realFetch; });

  const card = id => document.querySelector(`[data-message-id="${id}"]`);
  const button = (id, label) => [...card(id).querySelectorAll('button')].find(b => b.textContent === label);
  const click = async el => {
    await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
  };

  test('an open message offers star, mark unread, print and .eml', async () => {
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { key: 'actions', threadId: '<1@x>', folder: 'INBOX', selectedMessageId: 'm1' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    for (const label of ['contextMenu.star', 'contextMenu.markUnread', 'message.print', 'message.downloadEml']) {
      assert.ok(button('m1', label), `${label} is offered`);
    }
  });

  test('star goes through the server and the button flips to unstar', async () => {
    await click(button('m1', 'contextMenu.star'));
    const star = requests.find(r => r.url.includes('/mail/messages/m1/star'));
    assert.ok(star, 'the star was sent to the server');
    assert.equal(star.method, 'PATCH');
    assert.deepEqual(JSON.parse(star.body), { starred: true });
    assert.ok(button('m1', 'contextMenu.unstar'), 'the card now offers unstar');
  });

  // The server answers only once the mail server has the flag, which takes seconds on Gmail.
  test('the star changes at once, and is put back when the server refuses it', async (t) => {
    let answer;
    starAnswer = new Promise(resolve => { answer = resolve; });
    t.after(() => { starAnswer = null; });
    await click(button('m1', 'contextMenu.unstar'));
    assert.ok(button('m1', 'contextMenu.star'), 'unstarred before the server answered');
    await React.act(async () => { answer(false); await new Promise(r => setTimeout(r, 20)); });
    assert.ok(button('m1', 'contextMenu.unstar'), 'starred again once the server refused');
  });

  test('mark unread sends the unread change and hides the button', async () => {
    await click(button('m1', 'contextMenu.markUnread'));
    assert.deepEqual(bulkReads.at(-1), { ids: ['m1'], read: false });
    assert.equal(button('m1', 'contextMenu.markUnread'), undefined, 'an unread message offers no mark unread');
  });

  test('print conversation loads every body in order and prints once', async () => {
    const printAll = [...document.querySelectorAll('button')].find(b => b.textContent === 'message.printConversation');
    await click(printAll);
    await React.act(async () => { await new Promise(r => setTimeout(r, 100)); });
    assert.equal(printWin.printed, 1);
    const doc = printWin.writes.join('');
    const at = ['m1', 'm2', 'm3'].map(id => doc.indexOf(`body of ${id}`));
    assert.ok(at.every(i => i > 0), 'every message, including collapsed ones, is in the printout');
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in reading order');
  });

  test('AI actions run on the message and pin the result above it', async () => {
    const aiButton = button('m1', 'message.aiActions');
    assert.ok(aiButton, 'an open message offers AI actions when AI is enabled');
    await click(aiButton);
    const summarize = [...card('m1').querySelectorAll('[role="menuitem"]')].find(b => b.textContent === 'message.summarize');
    assert.ok(summarize, 'the menu lists Summarize');
    await click(summarize);
    await React.act(async () => { await new Promise(r => setTimeout(r, 100)); });
    const chat = requests.find(r => r.url.includes('/ai/chat'));
    assert.ok(chat, 'the action went to the AI endpoint');
    assert.match(JSON.parse(chat.body).messages[0].content, /body of m1/, 'with this message\'s text');
    assert.match(card('m1').textContent, /Short summary\./, 'the result is pinned on this message');
    assert.doesNotMatch(card('m3').textContent, /Short summary/, 'and only on this message');
  });

  test('the print shortcut prints the selected message', async () => {
    printWin = null;
    await React.act(async () => { shortcutBus.emit('printMessage'); });
    assert.ok(printWin, 'a print window opened');
    assert.equal(printWin.printed, 1);
    assert.match(printWin.writes.join(''), /body of m1/);
    assert.doesNotMatch(printWin.writes.join(''), /body of m3/);
  });

  // Archive takes the conversation out of the folder it is shown from, as the list's archive does:
  // the reply in Sent stays put.
  test('archive moves the Inbox copies and leaves the Sent reply', async () => {
    const archiveButton = [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === 'message.archive');
    assert.ok(archiveButton, 'the pane offers Archive');
    await click(archiveButton);
    await React.act(async () => { await new Promise(r => setTimeout(r, 4700)); });
    const archive = requests.find(r => r.url.includes('/mail/messages/bulk-archive'));
    assert.ok(archive, 'the archive was sent after the undo window');
    assert.deepEqual(JSON.parse(archive.body).ids.sort(), ['m1', 'm3']);
  });

  // #572: removing the conversation opens the next row in the list, not an empty pane.
  test('delete opens the next conversation in the list', async () => {
    const { useStore } = await import('../store/index.js');
    useStore.setState({ afterRemove: 'next', searchQuery: '' });
    useStore.getState().setMessages([
      { id: 'm3', thread_id: '<1@x>', account_id: 'acct', folder: 'INBOX', is_read: true },
      { id: 'n1', thread_id: '<9@x>', account_id: 'acct', folder: 'INBOX', is_read: true },
    ]);
    useStore.getState().setSelectedMessage('m1');
    const deleteButton = [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === 'message.delete');
    await click(deleteButton);
    assert.equal(useStore.getState().selectedMessageId, 'n1');
  });
});

describe('conversation pane on a phone', () => {
  test('the thread actions sit below a back bar with safe-area padding', async () => {
    // jsdom does no layout, so "a phone" is stated the way useMobile reads it:
    // innerWidth. A root of its own, because the shared one never remounts, so its
    // isMobile would never be recomputed. The bar this asserts is the whole fix: on a
    // phone this pane is the entire screen with no header of its own, so the thread
    // actions sat under the status bar a standalone PWA draws its content behind, and
    // there was no way back to the list at all.
    const container = document.createElement('div');
    document.body.appendChild(container);
    dom.window.innerWidth = 375;
    const mobileRoot = createRoot(container);
    try {
      await React.act(async () => {
        mobileRoot.render(React.createElement(ConversationPane, { threadId: '<1@x>', folder: 'INBOX' }));
      });
      await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

      const back = [...container.querySelectorAll('button')]
        .find(b => b.textContent.includes('common.back'));
      assert.ok(back, 'the conversation can be left on a phone');
      assert.equal(
        back.parentElement.style.paddingTop, 'calc(var(--sat) + 10px)',
        'the bar clears the status bar drawn over a standalone PWA');
      const actionsRow = [...container.querySelectorAll('button')]
        .find(b => b.textContent === 'message.archive');
      assert.ok(actionsRow, 'the thread actions still render');
      assert.ok(
        back.parentElement.compareDocumentPosition(actionsRow) & Node.DOCUMENT_POSITION_FOLLOWING,
        'and they sit below the bar, not under the status bar');
    } finally {
      await React.act(async () => mobileRoot.unmount());
      container.remove();
      dom.window.innerWidth = 1024;
    }
  });
});

// Rendered through ReadingPane, because the list's folder, account and row reach the pane's
// actions from there. Each test waits out the real undo window before the request is sent.
describe('conversation actions act on what the list is showing', () => {
  const click = el => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  beforeEach(() => { actionRequests = []; folderRequests = []; });

  test('Archive from an account\'s inbox leaves the Sent reply and another account\'s copy', async (t) => {
    // m3 was also delivered to a second account (#476). The pane shows that copy and the Sent
    // reply m2, but this account's inbox holds only m1 and m3.
    threadResponse = [...THREAD, { ...THREAD[2], id: 'x3', account_id: 'other' }];
    t.after(() => { threadResponse = THREAD; });
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId: 'acct', selectedFolder: 'INBOX', searchQuery: '',
        messages: [{ ...THREAD[2], thread_id: '<1@x>', message_count: 2 }], selectedMessageId: 'm3',
      });
      root.render(React.createElement(ReadingPane, { key: 'archive' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    await React.act(async () => { click(document.querySelector('button[title="message.archive"]')); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 4600)); });

    const archive = actionRequests.find(r => /bulk-archive/.test(r.url));
    assert.deepEqual(archive?.body.ids.sort(), ['m1', 'm3'], 'm2 stays in [Gmail]/Sent Mail and x3 in its own account');
  });

  test('Archive with the Sent reply picked under the row still takes the inbox copies', async () => {
    // A message picked under a row speaks for that row, which the list shows in the open folder:
    // only a parked message, which no row holds, takes its own folder.
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId: 'acct', selectedFolder: 'INBOX', searchQuery: '',
        messages: [{ ...THREAD[2], thread_id: '<1@x>', message_count: 2 }],
        threadMessages: { '<1@x>': THREAD.map(m => ({ ...m, thread_id: '<1@x>' })) }, selectedMessageId: 'm2',
      });
      root.render(React.createElement(ReadingPane, { key: 'picked-reply' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    await React.act(async () => { click(document.querySelector('button[title="message.archive"]')); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 4600)); });

    const archive = actionRequests.find(r => /bulk-archive/.test(r.url));
    assert.deepEqual(archive?.body.ids.sort(), ['m1', 'm3'], 'the reply stays in [Gmail]/Sent Mail');
  });

  test('Move lists the viewed account\'s folders and sends only that account\'s copies', async (t) => {
    // Account A's inbox, on a conversation whose reply was also delivered to B (#476). The two
    // copies share a Date and B's sorts last, so B's is the newest message in the pane.
    threadResponse = [
      { id: 'a1', account_id: 'A', folder: 'INBOX', message_id: '<5@x>', subject: 'Plan', from_email: 'c@x.z', from_name: 'Cy', date: '2026-02-01T10:00:00Z', is_read: true, snippet: '' },
      { id: 'a2', account_id: 'A', folder: 'INBOX', message_id: '<6@x>', subject: 'Re: Plan', from_email: 'c@x.z', from_name: 'Cy', date: '2026-02-02T10:00:00Z', is_read: true, snippet: '' },
      { id: 'b2', account_id: 'B', folder: 'INBOX', message_id: '<6@x>', subject: 'Re: Plan', from_email: 'c@x.z', from_name: 'Cy', date: '2026-02-02T10:00:00Z', is_read: true, snippet: '' },
    ];
    t.after(() => { threadResponse = THREAD; });
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId: 'A', selectedFolder: 'INBOX', searchQuery: '', recentFolders: [],
        messages: [{ ...threadResponse[1], thread_id: '<5@x>', message_count: 2 }], selectedMessageId: 'a2',
      });
      root.render(React.createElement(ReadingPane, { key: 'move' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    await React.act(async () => { click(document.querySelector('button[title="contextMenu.moveToFolder"]')); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    assert.deepEqual(folderRequests, ['A'], 'the picker lists the folders of the account being viewed');

    const projects = [...document.querySelectorAll('#root *')].filter(el => el.textContent === 'Projects').at(-1);
    await React.act(async () => { click(projects); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 4600)); });

    const move = actionRequests.find(r => /bulk-move/.test(r.url));
    assert.deepEqual(move?.body.ids.sort(), ['a1', 'a2'], 'B has no folder at that path, so its copy is not sent');
    assert.deepEqual(useStore.getState().recentFolders, [{ accountId: 'A', path: 'Projects' }]);
  });

  // A notification tap or a link parks the message it opens in threadMessages and selects it,
  // leaving the folder and account being viewed as they were. So does a GTD sidebar row.
  const tapped = { ...THREAD[2], thread_id: '<1@x>' };

  test('Delete on a conversation opened from a notification leaves the draft of the open Drafts folder', async (t) => {
    // Drafts is open and lists the conversation's draft reply, which is all the open folder
    // holds of it. bulk-delete expunges a draft outright rather than moving it to Trash.
    const draft = { id: 'm4', account_id: 'acct', folder: '[Gmail]/Drafts', message_id: '<4@x>', subject: 'Re: Welcome', from_email: 'me@x.z', from_name: 'Me', date: '2026-01-04T10:00:00Z', is_read: true, snippet: 'draft' };
    threadResponse = [...THREAD, draft];
    t.after(() => { threadResponse = THREAD; });
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId: 'acct', selectedFolder: '[Gmail]/Drafts', searchQuery: '',
        messages: [{ ...draft, thread_id: '<1@x>', message_count: 4 }],
        threadMessages: { __dl_m3: [tapped] }, selectedMessageId: 'm3',
      });
      root.render(React.createElement(ReadingPane, { key: 'tap-drafts' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    await React.act(async () => { click(document.querySelector('button[title="message.delete"]')); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 4600)); });

    const del = actionRequests.find(r => /bulk-delete/.test(r.url));
    assert.deepEqual(del?.body.ids.sort(), ['m1', 'm3'], 'the tapped message\'s inbox copies go to Trash, and m4 stays in Drafts');
  });

  test('Archive on a conversation opened from a notification takes its own account\'s copies', async (t) => {
    // Another account is open. m3 was delivered to it too (#476), and its copy is the
    // conversation's row there.
    const copy = { ...THREAD[2], id: 'x3', account_id: 'other' };
    threadResponse = [...THREAD, copy];
    t.after(() => { threadResponse = THREAD; });
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId: 'other', selectedFolder: 'INBOX', searchQuery: '',
        messages: [{ ...copy, thread_id: '<1@x>', message_count: 1 }],
        threadMessages: { __dl_m3: [tapped] }, selectedMessageId: 'm3',
      });
      root.render(React.createElement(ReadingPane, { key: 'tap-other-account' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    await React.act(async () => { click(document.querySelector('button[title="message.archive"]')); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 4600)); });

    const archive = actionRequests.find(r => /bulk-archive/.test(r.url));
    assert.deepEqual(archive?.body.ids.sort(), ['m1', 'm3'], 'acct\'s inbox copies: not its Sent reply m2, and not x3, which stays in the open inbox');
  });

  test('the Move picker closes when the selection moves to another account\'s copy meanwhile', async (t) => {
    // A's inbox lists an email delivered to A and B (#476) as A's row, and the picker lists A's
    // folders. While it is open, a notification tap selects B's copy of the same email, which the
    // pane then acts for (ReadingPane), so the picker goes rather than send B's copy to a path from
    // A. In the unified inbox a move takes every unified account's copies whichever is picked.
    threadResponse = [
      { id: 'a7', account_id: 'A', folder: 'INBOX', message_id: '<7@x>', subject: 'Trip', from_email: 'd@x.z', from_name: 'Di', date: '2026-03-01T10:00:00Z', is_read: true, snippet: '' },
      { id: 'b7', account_id: 'B', folder: 'INBOX', message_id: '<7@x>', subject: 'Trip', from_email: 'd@x.z', from_name: 'Di', date: '2026-03-01T10:00:00Z', is_read: true, snippet: '' },
    ];
    t.after(() => { threadResponse = THREAD; });
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId: 'A', selectedFolder: 'INBOX', searchQuery: '', recentFolders: [],
        messages: [{ ...threadResponse[0], thread_id: '<7@x>', message_count: 2 }], selectedMessageId: 'a7',
      });
      root.render(React.createElement(ReadingPane, { key: 'move-reselect' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    await React.act(async () => { click(document.querySelector('button[title="contextMenu.moveToFolder"]')); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    assert.deepEqual(folderRequests, ['A']);
    const pickerOpen = () => [...document.querySelectorAll('#root *')].some(el => el.textContent === 'Projects');
    assert.ok(pickerOpen(), 'the picker lists A\'s folders');

    await React.act(async () => {
      useStore.setState({ threadMessages: { __dl_b7: [{ ...threadResponse[1], thread_id: '<7@x>' }] }, selectedMessageId: 'b7' });
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    assert.ok(!pickerOpen(), 'A\'s folders are no longer offered for B\'s copy');
    assert.ok(!actionRequests.some(r => /bulk-move/.test(r.url)), 'and nothing is moved');
  });

  test('the Move picker closes when the pane switches to another conversation', async () => {
    // It lists the folders of the row it was opened on, so a notification tap that opens a
    // different conversation must not leave it acting on that one.
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId: 'acct', selectedFolder: 'INBOX', searchQuery: '',
        messages: [{ ...THREAD[2], thread_id: '<1@x>', message_count: 2 }], selectedMessageId: 'm3',
      });
      root.render(React.createElement(ReadingPane, { key: 'picker-switch' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    await React.act(async () => { click(document.querySelector('button[title="contextMenu.moveToFolder"]')); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const pickerOpen = () => [...document.querySelectorAll('#root *')].some(el => el.textContent === 'Projects');
    assert.ok(pickerOpen(), 'the picker lists the folders of acct');

    const other = { id: 'n1', account_id: 'acct', folder: 'INBOX', message_id: '<8@x>', thread_id: '<8@x>', subject: 'Other', from_email: 'e@x.z', from_name: 'Ed', date: '2026-01-05T10:00:00Z', is_read: true, snippet: '' };
    await React.act(async () => {
      useStore.setState({ threadMessages: { __dl_n1: [other] }, selectedMessageId: 'n1' });
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    assert.ok(!pickerOpen(), 'the picker opened on the previous conversation is gone');
  });
});

// Snooze in the conversation pane acts on the newest inbox message, as before, or with none in the
// inbox on a snoozed message, whose time it changes; with neither it is not offered. A snoozed
// message, or a conversation with nothing to snooze, used to get a picker that did nothing, or that
// moved the reader on to the next conversation as if it had snoozed this one.
describe('conversation snooze', () => {
  const message = (id, folder, day) => ({
    id, account_id: 'acct', folder, message_id: `<${id}@x>`, subject: 'Plans',
    from_email: folder === 'Sent' ? 'me@x.z' : 'a@x.z', date: `2026-02-0${day}T10:00:00Z`, is_read: true,
  });
  const THREADS = {
    // The reader wrote, and snoozed the answer.
    '<answer-snoozed@x>': [message('as1', 'Sent', 1), message('as2', 'Snoozed', 2)],
    // The reader replied, then snoozed what they replied to: their reply is the newest message.
    '<replied-then-snoozed@x>': [message('rs1', 'Snoozed', 1), message('rs2', 'Sent', 2)],
    // Two messages snoozed apart, each with its own time, and the reader's reply.
    '<two-snoozed@x>': [message('s1', 'Snoozed', 1), message('s2', 'Snoozed', 2), message('s3', 'Sent', 3)],
    // Filed and sent: nothing in the inbox, nothing snoozed.
    '<filed@x>': [message('f1', 'Archive', 1), message('f2', 'Sent', 2)],
    // Snoozed where the server keeps snoozed mail in INBOX.Snoozed: the thread route gives the copy
    // the folder its own snooze record names.
    '<prefix-snoozed@x>': [{ ...message('ps1', 'INBOX.Snoozed', 1), snoozed_folder: 'INBOX.Snoozed' }, message('ps2', 'Sent', 2)],
  };
  const requests = [];
  let realFetch;
  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      requests.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      const thread = u.includes('/mail/thread?') && THREADS[new URL(u, 'https://mail.example.invalid').searchParams.get('id')];
      if (thread) return { ok: true, status: 200, json: async () => ({ messages: thread }) };
      return realFetch(url, opts);
    };
  });
  after(() => { globalThis.fetch = realFetch; });
  beforeEach(() => { requests.length = 0; });

  const open = async (threadId, folder, { key = threadId, ...props } = {}) => {
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { key: `snooze-${key}`, threadId, folder, ...props }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
  };
  const button = title => [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === title);
  const snoozeButton = () => button('contextMenu.snooze.label');
  // Picker rows are an icon and their text: matched by their own text.
  const pickerRow = text => [...document.querySelectorAll('div')]
    .find(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === text));
  const click = async el => {
    await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  const clickSnooze = async () => {
    assert.ok(snoozeButton(), 'Snooze is offered');
    await click(snoozeButton());
  };
  const snoozeRequests = method => requests.filter(r => r.method === method && /\/snooze$/.test(r.url));

  test('the newest message snoozed: a preset changes when it comes back', async () => {
    await open('<answer-snoozed@x>', 'Sent');
    await clickSnooze();
    await click(pickerRow('contextMenu.snooze.threeHours'));
    const [change] = snoozeRequests('PATCH');
    assert.ok(change, 'the new time went to the server');
    assert.match(change.url, /\/messages\/as2\/snooze$/);
    assert.ok(new Date(change.body.until) > new Date(), 'a time in the future');
  });

  test('a snoozed message under a newer sent reply: the picker changes its time, and the reader stays', async (t) => {
    const { useStore } = await import('../store/index.js');
    // Opened from Sent, with another conversation listed after it.
    useStore.setState({ afterRemove: 'next', searchQuery: '' });
    useStore.getState().setMessages([
      { id: 'rs2', thread_id: '<replied-then-snoozed@x>', account_id: 'acct', folder: 'Sent', is_read: true },
      { id: 'next-row', thread_id: '<other@x>', account_id: 'acct', folder: 'Sent', is_read: true },
    ]);
    useStore.getState().setSelectedMessage('rs2');
    t.after(() => { useStore.getState().setMessages([]); useStore.getState().setSelectedMessage(null); });
    await open('<replied-then-snoozed@x>', 'Sent', { selectedMessageId: 'rs2' });
    await clickSnooze();
    assert.ok(pickerRow('contextMenu.snooze.change'), 'the picker says what it does');
    await click(pickerRow('contextMenu.snooze.threeHours'));
    const changes = snoozeRequests('PATCH');
    assert.equal(changes.length, 1, 'the new time went to the server');
    assert.match(changes[0].url, /\/messages\/rs1\/snooze$/, 'for the snoozed message, not the reply');
    // Nothing leaves the list, so the next conversation does not take this one's place.
    assert.equal(useStore.getState().selectedMessageId, 'rs2', 'the reader is still on the conversation');
  });

  test('of two snoozed messages, the time changed is that of the one the reader picked', async () => {
    await open('<two-snoozed@x>', 'Sent', { selectedMessageId: 's1' });
    await clickSnooze();
    await click(pickerRow('contextMenu.snooze.threeHours'));
    const changes = snoozeRequests('PATCH');
    assert.equal(changes.length, 1, 'the new time went to the server');
    assert.match(changes[0].url, /\/messages\/s1\/snooze$/, 'for the picked message, not the newer snoozed one');
  });

  test('nothing in the inbox and nothing snoozed: no Snooze is offered, and Move still is', async () => {
    await open('<filed@x>', 'Sent');
    assert.ok(button('message.archive'), 'the thread actions are there');
    assert.ok(!snoozeButton(), 'but not a Snooze that could not act');
    // Move's picker is given the newest message, not the snooze target, of which there is none.
    await click(button('contextMenu.moveToFolder'));
    assert.ok(pickerRow('contextMenu.folders.back'), 'Move opens its folder list');
  });

  test('an inbox conversation still snoozes its newest inbox message', async () => {
    await open('<1@x>', 'INBOX');
    await clickSnooze();
    assert.ok(pickerRow('contextMenu.snooze.label'), 'a plain Snooze');
    await click(pickerRow('contextMenu.snooze.threeHours'));
    await React.act(async () => { await new Promise(r => setTimeout(r, 4700)); });
    const snoozes = snoozeRequests('POST');
    assert.equal(snoozes.length, 1, 'sent after the undo window');
    assert.match(snoozes[0].url, /\/messages\/m3\/snooze$/);
  });

  test('the picker goes when the reader moves on to a conversation with nothing to snooze', async () => {
    await open('<1@x>', 'INBOX', { key: 'moving-on' });
    await clickSnooze();
    assert.ok(pickerRow('contextMenu.snooze.threeHours'), 'the picker is open');
    // The same pane, given the next conversation, as when the reader moves down the list.
    await open('<filed@x>', 'Sent', { key: 'moving-on' });
    assert.ok(!pickerRow('contextMenu.snooze.threeHours'), 'no snooze picker for a conversation with nothing to snooze');
  });

  // The folder is not named Snoozed, so only the record's folder tells the pane the copy is snoozed.
  test('snoozed into INBOX.Snoozed: the picker changes when it comes back', async () => {
    await open('<prefix-snoozed@x>', 'Sent');
    await clickSnooze();
    assert.ok(pickerRow('contextMenu.snooze.change'), 'the picker says what it does');
    await click(pickerRow('contextMenu.snooze.threeHours'));
    const changes = snoozeRequests('PATCH');
    assert.equal(changes.length, 1, 'the new time went to the server');
    assert.match(changes[0].url, /\/messages\/ps1\/snooze$/, 'for the snoozed copy, not the reply');
  });
});

// One email delivered to two of the reader's accounts (#476). The pane keeps showing both
// copies, but what it does to the conversation, and the card it opens, belong to the account
// of the row it was opened from. Mounted through ReadingPane, which is what decides that.
describe('a conversation another account also received', () => {
  // acct-b's copy of m3: same Message-ID and Date, listed after m3 as the thread route breaks
  // the tie (date, account_id, id), so it is the newest message on screen.
  const B3 = { ...THREAD[2], id: 'b3', account_id: 'acct-b', thread_id: '<1@x>' };
  const ROW = { ...THREAD[2], thread_id: '<1@x>', message_count: 2, unread_count: 1 };
  // The list's cache of the row's conversation once the reader has expanded it.
  const EXPANDED = { '<1@x>': [...THREAD.map(m => ({ ...m, thread_id: '<1@x>' })), B3] };
  // A link can open a message whose account the thread route does not cover (a disabled
  // account), so the pane shows only other accounts' copies of its conversation.
  const ORPHAN = { ...B3, id: 'c3', account_id: 'acct-c' };
  const requests = [];
  // The thread route serves [...THREAD, B3] unless a test serves a thread id of its own, and
  // answers only once a promise a test holds there resolves. It marks every message is_draft.
  const served = {};
  const held = {};
  let realFetch;
  before(async () => {
    // 'delete opens the next conversation in the list' leaves its delete inside the undo window.
    // Committed during these tests, it would re-read the thread through the stub below and add its
    // ids to their requests, so whatever is still pending is taken back first.
    await React.act(async () => { useStore.getState().notifications.forEach(n => n.onUndo?.()); });
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      requests.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
      if (u.includes('/mail/thread?')) {
        const id = new URLSearchParams(u.split('?')[1]).get('id');
        if (held[id]) await held[id];
        return { ok: true, status: 200, json: async () => ({ messages: (served[id] || [...THREAD, B3]).map(m => ({ is_draft: false, ...m })) }) };
      }
      if (/\/accounts\/[^/]+\/folders/.test(u)) return { ok: true, status: 200, json: async () => [{ path: 'INBOX', name: 'INBOX' }, { path: 'Projects', name: 'Projects' }] };
      return realFetch(url, opts);
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  const wait = ms => React.act(async () => { await new Promise(r => setTimeout(r, ms)); });
  const click = async el => {
    await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await wait(50);
  };
  // Clicks an action and runs out its undo window on a mocked clock. These tests are about which
  // copies an action takes, not when, and waiting out the real window in each of them made this
  // one of the slowest files in the suite.
  const commitWindow = async el => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      await React.act(async () => { mock.timers.tick(4600); await new Promise(r => setImmediate(r)); });
    } finally {
      // What the window left behind (the delete guards' expiry, a recent-folder save) runs now.
      // A module still holding a mocked timer would clear an unrelated one in a later window. A
      // minute rather than runAll(), which ticks only to the last timer in its queue, not the latest.
      await React.act(async () => { mock.timers.tick(60_000); await new Promise(r => setImmediate(r)); });
      mock.timers.reset();
    }
  };
  const open = async ({ selectedAccountId = 'acct', selected = ROW, threadMessages = {}, rows = [ROW], folder = 'INBOX' } = {}) => {
    requests.length = 0;
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId, selectedFolder: folder, searchQuery: '',
        searchResults: [], messages: rows, threadMessages, selectedMessageId: selected.id,
        markReadBehavior: 'immediate', recentFolders: [], notifications: [],
      });
      root.render(React.createElement(ReadingPane, { key: `${selectedAccountId}-${selected.id}-${Math.random()}` }));
    });
    await wait(50);
  };
  // Every request to the endpoint, so ids sent in a second request are not missed.
  const sentIds = pattern => requests.filter(r => pattern.test(r.url)).flatMap(r => r.body?.ids || []).sort();
  const threadFetches = () => requests.filter(r => r.url.includes('/mail/thread?'));
  const button = title => document.querySelector(`button[title="${title}"]`);
  const openIds = () => [...openCards()].map(c => c.closest('[data-message-id]')?.dataset.messageId).sort();
  const cardIds = () => [...document.querySelectorAll('[data-message-id]')].map(c => c.dataset.messageId).sort();
  // A boolean, not the element: a failing assertion on a jsdom node makes assert diff the whole
  // document, which runs the test out of memory instead of reporting the failure.
  const pickerOpen = () => Boolean(document.querySelector('input[placeholder="contextMenu.folders.search"]'));
  const textShown = text => [...document.querySelectorAll('span, div')].some(el => el.textContent === text);
  const menuEntry = name => [...document.querySelectorAll('span, div')].filter(el => el.textContent === name).at(-1);
  // The titles of the notices on screen; the i18n stub renders each as its key.
  const notices = () => useStore.getState().notifications.map(n => n.title);

  test('opening it marks the row account\'s copy read, not the other account\'s', async () => {
    await open();
    const read = requests.filter(r => r.url.includes('/bulk-read')).flatMap(r => r.body.ids);
    assert.ok(read.includes('m3'), 'the row\'s own copy is marked read');
    assert.ok(!read.includes('b3'), 'the other account\'s copy is left unread');
  });

  test('Delete sends only the row account\'s copies', async () => {
    // Its copies in the folder being viewed, as Archive takes: the Sent reply m2 stays in Sent.
    await open();
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['m1', 'm3']);
  });

  test('picking the other account\'s copy under the row still acts on the row\'s account', async () => {
    // The list expands the row with both copies, which look the same there and in the cards,
    // so which of the two the reader clicked must not decide whose mail is deleted.
    await open({ selected: B3, threadMessages: EXPANDED });
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['m1', 'm3']);
  });

  // acct's row of a conversation with a draft saved in each account, and a second one in acct-b's,
  // opened on the message picked under the row.
  const DRAFTED = [
    { ...THREAD[0], id: 'a50', message_id: '<50@x>', thread_id: '<50@x>' },
    { ...THREAD[2], id: 'a51', message_id: '<51@x>', thread_id: '<50@x>' },
    { ...THREAD[2], id: 'b51', account_id: 'acct-b', message_id: '<51@x>', thread_id: '<50@x>' },
    { ...THREAD[1], id: 'ad', folder: 'Drafts', message_id: '<52@x>', thread_id: '<50@x>', date: '2026-01-04T10:00:00Z', is_draft: true },
    { ...THREAD[1], id: 'bd', account_id: 'acct-b', folder: 'Drafts', message_id: '<53@x>', thread_id: '<50@x>', date: '2026-01-05T10:00:00Z', is_draft: true },
    { ...THREAD[1], id: 'bd2', account_id: 'acct-b', folder: 'Drafts', message_id: '<54@x>', thread_id: '<50@x>', date: '2026-01-06T10:00:00Z', is_draft: true },
  ];
  const openDrafted = id => {
    served['<50@x>'] = DRAFTED;
    return open({
      selected: DRAFTED.find(m => m.id === id),
      rows: [{ ...DRAFTED[1], message_count: 3, unread_count: 1 }],
      threadMessages: { '<50@x>': DRAFTED },
    });
  };

  test('Delete with the other account\'s draft picked under the row deletes that draft alone', async () => {
    // The reader opened acct-b's draft under acct's row and asked to delete it, the one message
    // outside acct that the pane takes. A deleted draft is expunged, so it goes alone: neither
    // acct-b's other draft nor acct's, which taking the conversation's drafts (keepDraftsApart)
    // would expunge with it.
    await openDrafted('bd');
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['bd']);
    assert.deepEqual(notices(), ['messageList.deleted.conversationTitle'], 'with no notice that nothing was taken');
    await openDrafted('ad');
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['ad'], 'acct\'s own draft picked takes acct\'s drafts, none of acct-b\'s');
  });

  test('Archive and Move with the other account\'s draft picked under the row take nothing and say so', async () => {
    // acct-b's draft stands for none of acct's mail, and acct's drafts were not picked. acct has
    // mail here, so the notice names the draft; and Move says so before a folder is picked.
    await openDrafted('bd');
    await commitWindow(button('message.archive'));
    await click(button('contextMenu.moveToFolder'));
    assert.equal(pickerOpen(), false, 'no move picker opens');
    assert.ok(!requests.some(r => /\/accounts\/[^/]+\/folders/.test(r.url)), 'no account\'s folders are listed');
    assert.ok(!requests.some(r => /bulk-archive|bulk-move/.test(r.url)), 'nothing is archived or moved');
    assert.equal(useStore.getState().selectedMessageId, 'bd', 'the pane stays on the draft');
    assert.deepEqual(notices(), ['message.moved.otherAccountDraft', 'message.archived.otherAccountDraft']);
  });

  test('picking the other account\'s copy under the row opens that copy alone', async () => {
    // Opening the row's own copy beside it marked that copy read, while the list row, whose
    // unread count follows the list's own mark-read and not a card's, stayed bold. acct-b's copy of
    // the first message, so the card that opens is not the newest one anyway.
    const B1 = { ...THREAD[0], id: 'b1', account_id: 'acct-b', thread_id: '<1@x>' };
    served['<1@x>'] = [...THREAD, B1, B3];
    try {
      await open({ selected: B1, threadMessages: { '<1@x>': [...EXPANDED['<1@x>'], B1] } });
      assert.deepEqual(openIds(), ['b1']);
      const read = requests.filter(r => r.url.includes('/bulk-read')).flatMap(r => r.body.ids);
      assert.ok(!read.includes('m3') && !read.includes('b3'), 'the newest copies are left as they were');
    } finally {
      delete served['<1@x>'];
    }
  });

  test('with the pane kept from one conversation to the next, the other account\'s copy picked under the next row opens alone', async () => {
    // ReadingPane keeps the same pane when the reader moves on, so the pick read when the next
    // conversation lands has to be the current one, not the one the pane was first opened on.
    const TWO = [
      { ...THREAD[0], id: 'y1', message_id: '<60@x>', thread_id: '<60@x>', subject: 'Two', is_read: false },
      { ...THREAD[0], id: 'yb1', account_id: 'acct-b', message_id: '<60@x>', thread_id: '<60@x>', subject: 'Two', is_read: false },
      { ...THREAD[2], id: 'y2', message_id: '<61@x>', thread_id: '<60@x>', subject: 'Re: Two' },
    ];
    served['<60@x>'] = TWO;
    await open({ rows: [ROW, { ...TWO[2], message_count: 2, unread_count: 2 }], threadMessages: { '<60@x>': TWO } });
    requests.length = 0;
    await React.act(async () => { useStore.setState({ selectedMessageId: 'yb1' }); });
    await wait(50);
    assert.deepEqual(openIds(), ['yb1']);
    const read = requests.filter(r => r.url.includes('/bulk-read')).flatMap(r => r.body.ids);
    assert.deepEqual(read, ['yb1'], 'acct\'s newest copy is left unread');
  });

  test('picking another message of the conversation neither fetches it again nor closes what the reader opened', async () => {
    // Which message was picked decides the card that opens when the conversation arrives, but a
    // pick within it is not a reason to fetch it again.
    await open({ threadMessages: EXPANDED });
    await click(document.querySelector('[data-message-id="m1"] [aria-expanded]'));
    assert.deepEqual(openIds(), ['m1', 'm3'], 'the reader opened m1 beside m3');
    const fetched = threadFetches().length;
    await React.act(async () => { useStore.setState({ selectedMessageId: 'm2' }); });
    await wait(50);
    assert.equal(threadFetches().length, fetched, 'the conversation is not fetched again');
    assert.deepEqual(openIds(), ['m1', 'm2', 'm3'], 'the cards the reader opened stay open');
  });

  test('Archive with the other account\'s copy picked under the row archives the row account\'s copies', async () => {
    // Archive took one account's copies already, but the account of the copy picked: here acct-b's,
    // whose copy sits in an INBOX too.
    await open({ selected: B3, threadMessages: EXPANDED });
    await commitWindow(button('message.archive'));
    assert.deepEqual(sentIds(/bulk-archive/), ['m1', 'm3']);
  });

  test('Archive from a label whose copy the thread does not list takes none of the other account\'s copies', async () => {
    // The thread route keeps one copy per account and Message-ID, the INBOX one first, so a label
    // folder's row is not in the conversation. Taken from the selected message, the account was
    // then none, and Archive fell back to the newest message on screen: acct-b's copy. The fallback
    // now keeps to the row's account, and the row, which ReadingPane hands the pane, stands in for
    // the copy the thread lacks, so what leaves the label is the label's own copy.
    const LABELLED = { ...ROW, id: 'w3', folder: 'Work' };
    await open({ selected: LABELLED, rows: [LABELLED], folder: 'Work' });
    await commitWindow(button('message.archive'));
    assert.deepEqual(sentIds(/bulk-archive/), ['w3'], 'the row\'s copy, and none of acct-b\'s');
  });

  test('the next conversation opens only once an action has taken something', async () => {
    // #572 opens the row after this one when the conversation leaves the list. An action that takes
    // nothing leaves it there, so nothing opens in its place, and says so; one that takes the row
    // account's copies opens the next row, whichever copy the reader picked, and shows only its
    // undo toast.
    await React.act(async () => { useStore.setState({ afterRemove: 'next' }); });
    const NEXT = { ...ROW, id: 'n1', message_id: '<40@x>', thread_id: '<40@x>' };
    // In acct's Sent view the row's copies are the reader's own, which Spam spares.
    served['<41@x>'] = [
      { ...THREAD[1], id: 's41', folder: 'Sent', message_id: '<41@x>', thread_id: '<41@x>' },
      { ...THREAD[1], id: 's42', folder: 'Sent', message_id: '<42@x>', thread_id: '<41@x>', date: '2026-01-04T10:00:00Z' },
      { ...THREAD[2], id: 'b43', account_id: 'acct-b', message_id: '<43@x>', thread_id: '<41@x>', date: '2026-01-05T10:00:00Z' },
    ];
    const sentRow = { ...served['<41@x>'][1], message_count: 2, unread_count: 0 };

    await open({ selected: sentRow, rows: [sentRow, NEXT], folder: 'Sent' });
    await commitWindow(button('contextMenu.markAsSpam'));
    assert.equal(useStore.getState().selectedMessageId, sentRow.id, 'Spam with only the reader\'s own mail opens nothing');
    assert.deepEqual(notices(), ['spam.nothingFromAccount']);

    await open({ selected: ORPHAN, threadMessages: { '__dl_c3': [ORPHAN] }, rows: [ROW, NEXT] });
    await commitWindow(button('message.delete'));
    assert.equal(useStore.getState().selectedMessageId, ORPHAN.id, 'nor Delete with none of the account\'s copies');
    assert.deepEqual(notices(), ['messageList.deleted.nothingFromAccount']);

    await open({ selected: B3, threadMessages: EXPANDED, rows: [ROW, NEXT] });
    await commitWindow(button('message.delete'));
    assert.equal(useStore.getState().selectedMessageId, NEXT.id, 'Delete of the row account\'s copies opens the next row');
    assert.deepEqual(sentIds(/bulk-delete/), ['m1', 'm3']);
    assert.deepEqual(notices(), ['messageList.deleted.conversationTitle'], 'its undo toast is the only notice');
  });

  test('Move lists the row account\'s folders and moves only its copies', async () => {
    await open();
    await click(button('contextMenu.moveToFolder'));
    assert.ok(requests.some(r => r.url.includes('/accounts/acct/folders')), 'the picker lists the row account\'s folders');
    assert.ok(!requests.some(r => r.url.includes('/accounts/acct-b/folders')), 'not the other account\'s');
    await commitWindow(menuEntry('Projects'));
    assert.deepEqual(sentIds(/bulk-move/), ['m1', 'm2', 'm3']);
  });

  test('Move in the unified inbox still sends every unified account\'s copies', async () => {
    // A unified row stands for every unified account's copies, and the server moves each copy
    // where its own account has that folder.
    await open({ selectedAccountId: null });
    await click(button('contextMenu.moveToFolder'));
    await commitWindow(menuEntry('Projects'));
    assert.deepEqual(sentIds(/bulk-move/), ['b3', 'm1', 'm2', 'm3']);
  });

  test('the snooze picker opens on the row account\'s copy', async (t) => {
    // On what Snooze acts on, acct's newest inbox copy: b3 is the newest message on screen, but it
    // is acct-b's. The probe reads the message ContextMenu was given, as its plugin items get it.
    const handed = [];
    registerCollector('context-menu-actions', { pluginId: 'probe-476', build: ctx => { handed.push(ctx.message.id); return []; } });
    const enabledPlugins = useStore.getState().enabledPlugins;
    // Inside act: the picker is still open, and the store change re-renders it.
    t.after(() => React.act(async () => { useStore.setState({ enabledPlugins }); }));
    await open();
    await React.act(async () => { useStore.setState({ enabledPlugins: ['probe-476'] }); });
    await click(button('contextMenu.snooze.label'));
    assert.ok(textShown('contextMenu.snooze.threeHours'), 'the snooze picker is open');
    assert.deepEqual([...new Set(handed)], ['m3']);
  });

  // Until the next conversation lands, the previous one's cards and buttons stay on screen, so the
  // picker has to close at the switch itself, not only once the next conversation arrives.
  test('an open picker closes when the reader moves to another conversation', async () => {
    const OTHER = { ...ROW, id: 'x1', message_id: '<9@x>', thread_id: '<9@x>' };
    await open({ rows: [ROW, OTHER] });
    await click(button('contextMenu.moveToFolder'));
    assert.ok(pickerOpen(), 'the picker is open');
    let land;
    held['<9@x>'] = new Promise(resolve => { land = resolve; });
    try {
      await React.act(async () => { useStore.setState({ selectedMessageId: OTHER.id }); });
      await wait(50);
      assert.equal(pickerOpen(), false, 'a pick cannot land on the next conversation');
    } finally {
      await React.act(async () => { land(); delete held['<9@x>']; });
      await wait(50);
    }
  });

  test('an open picker closes when the conversation is opened for another account', async () => {
    // A notification tap for acct-b's copy of the same conversation keeps the thread id.
    await open();
    await click(button('contextMenu.moveToFolder'));
    assert.ok(pickerOpen(), 'the picker is open');
    // Every other test fetches this conversation, so the hold ends whatever happens here.
    let land;
    held['<1@x>'] = new Promise(resolve => { land = resolve; });
    try {
      await React.act(async () => { useStore.setState({ threadMessages: { '__dl_b3': [B3] }, selectedMessageId: B3.id }); });
      await wait(50);
      assert.equal(pickerOpen(), false, 'acct\'s folders are not offered for acct-b\'s copies');
    } finally {
      await React.act(async () => { land(); delete held['<1@x>']; });
      await wait(50);
    }
  });

  test('a picker opened while the next conversation loads closes when that one lands', async () => {
    // The previous conversation's cards and buttons stay on screen until the next one arrives. A
    // picker opened on them kept that conversation's copy for its menu (the folders listed, GTD
    // classify) while its pick went to the conversation that had landed.
    const NEXT = [
      { ...THREAD[0], id: 'x1', message_id: '<20@x>', thread_id: '<20@x>', subject: 'Other' },
      { ...THREAD[2], id: 'x2', message_id: '<21@x>', thread_id: '<20@x>', subject: 'Re: Other' },
    ];
    served['<20@x>'] = NEXT;
    const OTHER = { ...NEXT[1], message_count: 2, unread_count: 0 };
    await open({ rows: [ROW, OTHER] });
    let land;
    held['<20@x>'] = new Promise(resolve => { land = resolve; });
    await React.act(async () => { useStore.setState({ selectedMessageId: OTHER.id }); });
    await wait(20);
    assert.deepEqual(cardIds(), ['b3', 'm1', 'm2', 'm3'], 'the previous conversation is still on screen');
    await click(button('contextMenu.snooze.label'));
    assert.ok(textShown('contextMenu.snooze.threeHours'), 'a picker opens on it');
    await React.act(async () => { land(); delete held['<20@x>']; });
    await wait(50);
    assert.deepEqual(cardIds(), ['x1', 'x2'], 'the next conversation landed');
    assert.equal(textShown('contextMenu.snooze.threeHours'), false, 'and the picker opened on the previous one is gone');
  });

  test('a message opened from a notification in another account\'s view acts on its own account\'s copies', async () => {
    // MailApp parks a deep-linked message in threadMessages without changing the selected
    // account, so the opened message, not the sidebar, says which account the action is for.
    await open({ selected: B3, threadMessages: { '__dl_b3': [B3] } });
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['b3']);
  });

  test('a notification tapped while the row\'s conversation is cached still acts on its own account', async () => {
    // Expanding the row cached the same copy under the thread id. The tap, not the cache, says
    // which copy the reader opened; picking it from the list later ends that (MessageList).
    await open({ selected: B3, threadMessages: { ...EXPANDED, '__dl_b3': [B3] } });
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['b3']);
  });

  test('the reply draft button over a message opened from a notification leaves it parked', async () => {
    // ReadingPane shows the button on the message it has open, here acct's own message, which the
    // inbox's reply draft lookup covers. Picking that message again is not a pick from the list:
    // unparked, a message that no row holds would leave the pane.
    const M1 = { ...THREAD[0], thread_id: '<1@x>' };
    await open({ selected: M1, threadMessages: { '__dl_m1': [M1] }, rows: [] });
    await React.act(async () => { useStore.setState({ replyDrafts: { m1: { exists: true } } }); });
    const draftButton = button('messageList.openReplyDraft');
    assert.ok(draftButton, 'the reading pane offers the reply draft');
    await click(draftButton);
    assert.ok(useStore.getState().threadMessages.__dl_m1, 'the message stays parked');
    assert.deepEqual(cardIds(), ['b3', 'm1', 'm2', 'm3'], 'and its conversation stays on screen');
    await React.act(async () => { useStore.setState({ replyDrafts: {} }); });
  });

  test('a row of the other account in this account\'s list acts for its own account', async () => {
    // Undoing an action on a message opened from a notification, here acct-b's copy, adds it to
    // the list: restoreMessages adds every message the action took that the list lacks. Picked
    // there it is a row of acct-b's, which the list's actions on it act for, and so do the pane's.
    await open({ selected: B3, rows: [ROW, B3] });
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['b3']);
    assert.deepEqual(useStore.getState().messages.map(m => m.id), [ROW.id], 'acct\'s row stays listed');
  });

  test('acting for a notification\'s copy leaves the row of the view\'s account listed, and opens nothing in its place', async () => {
    // The row shares the conversation's thread id with acct-b's copy, but what the action takes is
    // acct-b's, so the row stays. Opening the row after it (#572) moved the reader past a row still
    // there, and through the list's row opener marked that next conversation read.
    await React.act(async () => { useStore.setState({ afterRemove: 'next' }); });
    const NEXT = { ...ROW, id: 'n1', message_id: '<40@x>', thread_id: '<40@x>' };
    for (const [title, endpoint] of [['message.archive', /bulk-archive/], ['message.delete', /bulk-delete/]]) {
      await open({ selected: B3, threadMessages: { '__dl_b3': [B3] }, rows: [ROW, NEXT] });
      await commitWindow(button(title));
      assert.deepEqual(sentIds(endpoint), ['b3'], `${title} takes acct-b's copy`);
      assert.deepEqual(useStore.getState().messages.map(m => m.id), [ROW.id, NEXT.id], `${title} leaves acct's row listed`);
      assert.equal(useStore.getState().selectedMessageId, null, `${title} opens nothing in its place`);
    }
  });

  test('acting in a notification\'s own folder leaves the row of the folder being viewed listed, and opens nothing in its place', async () => {
    // Archive and Delete on a message opened from a notification take its own folder's copies
    // (ReadingPane), here the inbox's, so with Sent open the conversation's Sent row stays. The row is
    // acct's, as the action is, and opening the row after it moved the reader past a row still there.
    await React.act(async () => { useStore.setState({ afterRemove: 'next' }); });
    const SENT_ROW = { ...THREAD[1], thread_id: '<1@x>', message_count: 2, unread_count: 0 };
    const NEXT = { ...SENT_ROW, id: 'n1', message_id: '<40@x>', thread_id: '<40@x>' };
    const M3 = { ...THREAD[2], thread_id: '<1@x>' };
    for (const [title, endpoint] of [['message.archive', /bulk-archive/], ['message.delete', /bulk-delete/]]) {
      await open({ selected: M3, threadMessages: { '__dl_m3': [M3] }, rows: [SENT_ROW, NEXT], folder: SENT_ROW.folder });
      await commitWindow(button(title));
      assert.deepEqual(sentIds(endpoint), ['m1', 'm3'], `${title} takes acct's inbox copies`);
      assert.deepEqual(useStore.getState().messages.map(m => m.id), [SENT_ROW.id, NEXT.id], `${title} leaves the Sent row listed`);
      assert.equal(useStore.getState().selectedMessageId, null, `${title} opens nothing in its place`);
    }
  });

  test('with no row of the conversation listed, an action that leaves the opened message there clears the pane', async () => {
    // Snooze takes only the newest inbox copy, so the older message opened from a notification is
    // not among what it takes, and there is no row to open the next one from.
    const M1 = { ...THREAD[0], thread_id: '<1@x>' };
    await open({ selected: M1, threadMessages: { '__dl_m1': [M1] }, rows: [] });
    await click(button('contextMenu.snooze.label'));
    await commitWindow(menuEntry('contextMenu.snooze.threeHours'));
    assert.ok(requests.some(r => /\/messages\/m3\/snooze$/.test(r.url)), 'acct\'s newest inbox copy is snoozed');
    assert.equal(useStore.getState().selectedMessageId, null, 'and the pane clears');
  });

  test('in the unified inbox a message opened from a notification acts like the row there', async () => {
    // Which copy the unified list shows as the row is the server's tie-break, invisible to the
    // reader, so the opened copy and the row act on the same thing: every unified account's copies
    // in the inbox, where the opened copy is. The Sent reply m2 stays in Sent.
    await open({ selectedAccountId: null, selected: B3, threadMessages: { '__dl_b3': [B3] }, rows: [] });
    assert.ok(threadFetches().every(r => /unified=true/.test(r.url)), 'the conversation is the unified inbox\'s');
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['b3', 'm1', 'm3']);
  });

  test('in the unified inbox a refresh that lists the opened message changes nothing in the pane', async () => {
    // A push tap opens its message before the first list load, which then brings it in as the
    // unified row. The pane must not refetch, close the cards the reader opened, or change what
    // its buttons act on.
    await open({ selectedAccountId: null, selected: B3, threadMessages: { '__dl_b3': [B3] }, rows: [] });
    await click(document.querySelector('[data-message-id="m1"] [aria-expanded]'));
    assert.deepEqual(openIds(), ['b3', 'm1']);
    const fetched = threadFetches().length;
    await React.act(async () => { useStore.setState({ messages: [{ ...B3, message_count: 2, unread_count: 0 }] }); });
    await wait(50);
    assert.equal(threadFetches().length, fetched, 'the conversation is not fetched again');
    assert.deepEqual(openIds(), ['b3', 'm1'], 'the cards the reader opened stay open');
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['b3', 'm1', 'm3']);
  });

  test('Move opens nothing, and Snooze is not offered, when the conversation holds none of that account\'s copies', async () => {
    // Moving or snoozing the copies on screen would act on other accounts' mail. Snooze has
    // nothing of that account's to act on, so there is no Snooze to press (conversationSnoozeTarget).
    await open({ selected: ORPHAN, threadMessages: { '__dl_c3': [ORPHAN] } });
    await click(button('contextMenu.moveToFolder'));
    assert.ok(!requests.some(r => /\/accounts\/[^/]+\/folders/.test(r.url)), 'no account\'s folders are listed');
    assert.equal(pickerOpen(), false, 'no move picker opens');
    assert.equal(Boolean(button('contextMenu.snooze.label')), false, 'no Snooze is offered');
    assert.ok(button('message.delete'), 'the pane is still there');
    assert.deepEqual(notices(), ['message.moved.nothingFromAccount'], 'Move says why');
  });

  test('Archive, Delete and Spam leave the pane open and say why when it holds none of that account\'s copies', async () => {
    // Nothing on screen is that account's, so there is nothing to act on. Clearing the pane as
    // if the action had worked would hide that, and so would a refusal the reader cannot see.
    for (const [title, notice] of [
      ['message.archive', 'message.archived.nothingFromAccount'],
      ['message.delete', 'messageList.deleted.nothingFromAccount'],
      ['contextMenu.markAsSpam', 'spam.nothingFromAccount'],
    ]) {
      await open({ selected: ORPHAN, threadMessages: { '__dl_c3': [ORPHAN] } });
      await commitWindow(button(title));
      assert.equal(useStore.getState().selectedMessageId, 'c3', `${title} does not close the pane as if it had worked`);
      assert.ok(button(title), `${title} leaves the conversation on screen`);
      assert.ok(!requests.some(r => /bulk-archive|bulk-delete|\/messages\/[^/]+\/spam/.test(r.url)), `${title} sends nothing`);
      assert.deepEqual(notices(), [notice], `${title} says why`);
    }
  });

  // The account has copies on screen, but none Snooze acts on. Unscoped, the action took acct-b's
  // copy instead; scoped, there is nothing of the account's to snooze, so Snooze is not offered.
  test('Snooze is not offered when none of the account\'s copies is in its inbox or snoozed', async () => {
    // In acct's Archive view the row's copies are filed, and Snooze takes only an inbox copy, or
    // changes the time of a snoozed one. acct-b's inbox copy is not acct's to snooze.
    const FILED = [
      { ...THREAD[0], id: 'a6o', folder: 'Archive', message_id: '<6@x>', thread_id: '<6@x>' },
      { ...THREAD[2], id: 'a6n', folder: 'Archive', message_id: '<7@x>', thread_id: '<6@x>' },
      { ...THREAD[2], id: 'b6n', account_id: 'acct-b', message_id: '<7@x>', thread_id: '<6@x>' },
    ];
    served['<6@x>'] = FILED;
    const row = { ...FILED[1], message_count: 2, unread_count: 0 };
    await open({ selected: row, rows: [row], folder: 'Archive' });
    assert.equal(Boolean(button('contextMenu.snooze.label')), false, 'no Snooze is offered');
    assert.ok(button('message.delete'), 'the conversation stays on screen');
    assert.ok(!requests.some(r => /\/snooze$/.test(r.url)), 'nothing is snoozed');
  });

  test('Spam with only the reader\'s own mail in the account leaves the pane open and says why', async () => {
    // In acct's Sent view the row's copies are the reader's own, which Spam spares.
    const OWN = [
      { ...THREAD[1], id: 's1', folder: 'Sent', message_id: '<11@x>', thread_id: '<11@x>' },
      { ...THREAD[1], id: 's2', folder: 'Sent', message_id: '<12@x>', thread_id: '<11@x>', date: '2026-01-04T10:00:00Z' },
      { ...THREAD[2], id: 'b13', account_id: 'acct-b', message_id: '<13@x>', thread_id: '<11@x>', date: '2026-01-05T10:00:00Z' },
    ];
    served['<11@x>'] = OWN;
    const row = { ...OWN[1], message_count: 2, unread_count: 0 };
    await open({ selected: row, rows: [row], folder: 'Sent' });
    await commitWindow(button('contextMenu.markAsSpam'));
    assert.equal(useStore.getState().selectedMessageId, 's2', 'the pane is not closed as if the report had worked');
    assert.ok(button('message.delete'), 'the conversation stays on screen');
    assert.ok(!requests.some(r => /\/spam$/.test(r.url)), 'nothing is reported');
    assert.deepEqual(notices(), ['spam.nothingFromAccount'], 'the reader is told why');
  });

  // The unified inbox has no single account to name, and there Spam and Snooze can come up empty:
  // Archive, Delete and Move take something there but in one rare case (NOTHING_TO_TAKE in
  // ConversationPane.jsx). Snooze is not offered at all with nothing to act on.
  test('in the unified inbox Spam that finds nothing says so without naming an account, and Snooze is not offered', async () => {
    // Notes the reader sent themselves: in the inbox, but from their own address, which Spam spares.
    const NOTES = [
      { ...THREAD[1], id: 'u1', folder: 'INBOX', account_email: 'me@x.z', message_id: '<80@x>', thread_id: '<80@x>' },
      { ...THREAD[1], id: 'u2', folder: 'INBOX', account_email: 'me@x.z', message_id: '<81@x>', thread_id: '<80@x>', date: '2026-01-04T10:00:00Z' },
    ];
    served['<80@x>'] = NOTES;
    const row = { ...NOTES[1], message_count: 2, unread_count: 0 };
    await open({ selectedAccountId: null, selected: row, rows: [row] });
    await commitWindow(button('contextMenu.markAsSpam'));
    assert.ok(!requests.some(r => /\/spam$/.test(r.url)), 'nothing is reported');
    assert.equal(useStore.getState().selectedMessageId, 'u2', 'the pane stays open');
    assert.deepEqual(notices(), ['spam.nothingInConversation'], 'Spam says why');

    // Opened from the GTD sidebar with the unified inbox selected: every copy is filed, and none
    // is snoozed.
    const FILED = [
      { ...THREAD[0], id: 'f1', folder: 'Archive', message_id: '<82@x>', thread_id: '<82@x>' },
      { ...THREAD[2], id: 'f2', folder: 'Archive', message_id: '<83@x>', thread_id: '<82@x>' },
      { ...THREAD[2], id: 'fb2', account_id: 'acct-b', folder: 'Archive', message_id: '<83@x>', thread_id: '<82@x>' },
    ];
    served['<82@x>'] = FILED;
    await open({ selectedAccountId: null, selected: FILED[1], threadMessages: { '__dl_f2': [FILED[1]] }, rows: [] });
    assert.equal(Boolean(button('contextMenu.snooze.label')), false, 'no Snooze is offered');
    assert.ok(!requests.some(r => /\/snooze$/.test(r.url)), 'nothing is snoozed');
    assert.equal(useStore.getState().selectedMessageId, 'f2', 'the pane stays open');
  });

  test('in the unified inbox the conversation still acts on every account\'s copies', async () => {
    // Every account's copies in the inbox, as the unified row's: the Sent reply m2 stays in Sent.
    await open({ selectedAccountId: null });
    await commitWindow(button('message.delete'));
    assert.deepEqual(sentIds(/bulk-delete/), ['b3', 'm1', 'm3']);
  });

  test('a GTD row whose copy is gone opens none of another account\'s mail in its account\'s view', async (t) => {
    // The click recovers through the row's thread, which now holds only acct-b's copy. Parked, that
    // copy would have the pane act for acct-b from acct's row. The unified inbox still opens it.
    t.mock.method(console, 'warn', () => {});
    t.mock.method(api, 'getMessage', async () => { throw Object.assign(new Error('Not found'), { status: 404 }); });
    served['<30@x>'] = [{ ...B3, id: 'b30', message_id: '<30@x>', thread_id: '<30@x>' }];
    const row = { id: 'a30', account_id: 'acct', message_id: '<30@x>', thread_key: '<30@x>', is_read: true };
    const { scheduleGtdSectionsFetch } = useStore.getState();
    let triage;
    const Rail = () => { triage = useGtdTriage(); return null; };
    const railContainer = document.body.appendChild(document.createElement('div'));
    const rail = createRoot(railContainer);
    await React.act(async () => {
      useStore.setState({ scheduleGtdSectionsFetch: () => {} });
      rail.render(React.createElement(Rail));
    });
    t.after(() => React.act(async () => {
      rail.unmount();
      railContainer.remove();
      useStore.setState({ scheduleGtdSectionsFetch });
    }));
    for (const [selectedAccountId, selected] of [['acct', ROW.id], [null, 'b30']]) {
      await open({ selectedAccountId });
      await React.act(async () => { await triage.openRow(row); });
      await wait(50);
      assert.equal(useStore.getState().selectedMessageId, selected, `selected in ${selectedAccountId || 'the unified'} view`);
    }
  });
});
