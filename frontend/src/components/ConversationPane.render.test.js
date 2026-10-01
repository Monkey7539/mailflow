// Render test for the conversation pane.
//
// The behavior that matters, and that a util test cannot show, is that a thread renders one
// card per message with only the newest open, and that opening another card mounts a second
// body. That is the whole point of the Gmail-style view: bodies are expensive, so only what
// the reader has opened is rendered.
//
// Same loader hooks as MessagePane.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed because a real i18n instance would test i18next.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    return { ok: true, status: 200, json: async () => ({ html: `<p>body of ${id}</p>`, text: '', attachments: [], hasBlockedRemoteImages: blockImages && !remote }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ConversationPane = (await import('./ConversationPane.jsx')).default;
const ReadingPane = (await import('./ReadingPane.jsx')).default;
const { useStore } = await import('../store/index.js');
const { shortcutBus } = await import('../utils/shortcutBus.js');
const { api } = await import('../utils/api.js');

let root;
before(() => { root = createRoot(document.getElementById('root')); });
after(async () => { await React.act(async () => root.unmount()); });

const cards = () => document.querySelectorAll('[aria-expanded]');
const openCards = () => document.querySelectorAll('[aria-expanded="true"]');

describe('conversation pane', () => {
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
    const email = new dom.window.DOMParser().parseFromString(frame.getAttribute('srcdoc'), 'text/html');
    assert.equal(email.querySelector('p').closest('[translate]')?.getAttribute('translate'), 'yes');
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
  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      requests.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
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

  test('Move sends the account whose folders the picker listed when the selection changes meanwhile', async (t) => {
    // The unified inbox lists an email delivered to A and B (#476) as A's row. While the picker
    // is open, a notification tap selects B's copy of the same email.
    threadResponse = [
      { id: 'a7', account_id: 'A', folder: 'INBOX', message_id: '<7@x>', subject: 'Trip', from_email: 'd@x.z', from_name: 'Di', date: '2026-03-01T10:00:00Z', is_read: true, snippet: '' },
      { id: 'b7', account_id: 'B', folder: 'INBOX', message_id: '<7@x>', subject: 'Trip', from_email: 'd@x.z', from_name: 'Di', date: '2026-03-01T10:00:00Z', is_read: true, snippet: '' },
    ];
    t.after(() => { threadResponse = THREAD; });
    await React.act(async () => {
      useStore.setState({
        conversationMode: 'pane', selectedAccountId: null, selectedFolder: 'INBOX', searchQuery: '', recentFolders: [],
        messages: [{ ...threadResponse[0], thread_id: '<7@x>', message_count: 2 }], selectedMessageId: 'a7',
      });
      root.render(React.createElement(ReadingPane, { key: 'move-reselect' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    await React.act(async () => { click(document.querySelector('button[title="contextMenu.moveToFolder"]')); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    assert.deepEqual(folderRequests, ['A']);

    await React.act(async () => {
      useStore.setState({ threadMessages: { __dl_b7: [{ ...threadResponse[1], thread_id: '<7@x>' }] }, selectedMessageId: 'b7' });
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const projects = [...document.querySelectorAll('#root *')].filter(el => el.textContent === 'Projects').at(-1);
    await React.act(async () => { click(projects); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 4600)); });

    const move = actionRequests.find(r => /bulk-move/.test(r.url));
    assert.deepEqual(move?.body.ids, ['a7'], 'A\'s copy goes to A\'s folder, and B\'s is not sent to a path from A');
    assert.deepEqual(useStore.getState().recentFolders, [{ accountId: 'A', path: 'Projects' }]);
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
