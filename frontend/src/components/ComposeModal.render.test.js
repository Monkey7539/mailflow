// Render test for ComposeModal's draft autosave (#413).
//
// The autosave rules are unit-tested in utils/draftAutosave.test.js, but whether a draft counts
// as dirty depends on the live TipTap editor, which rewrites the HTML it loads. That only shows
// up with the real component mounted, so this mounts it the same way the other render tests do.

import { test, describe, before, after } from 'node:test';
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
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

// A draft as Gmail saves it. TipTap loads this as <p> paragraphs, so its getHTML() never
// matches the stored string even when nobody has touched it.
const GMAIL_DRAFT = '<div dir="ltr">Hi Bob,<div><br></div><div>The contract is attached.</div></div>';

const saved = [];

// Autosave also runs when the tab is hidden, without waiting for the idle timer, which makes
// it the deterministic way to ask the composer "would you save now?".
async function hideTab() {
  visibility = 'hidden';
  await React.act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
  await React.act(async () => {});
  visibility = 'visible';
}

// Opens a draft the way MessageList does for a click in the Drafts folder. Returns an unmount.
async function openDraft({ plaintextEmail, body }) {
  saved.length = 0;
  useStore.setState({ plaintextEmail });
  useStore.getState().openCompose({
    accountId: 'acct',
    draftUid: 7,
    draftFolder: 'Drafts',
    to: ['Bob <bob@example.invalid>'],
    cc: [],
    subject: 'Contract',
    body,
    bodyIsHtml: !plaintextEmail,
  });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  // immediatelyRender: false creates the editor in an effect after the first commit.
  await React.act(async () => {});
  return () => React.act(async () => root.unmount());
}

before(() => {
  api.saveDraft = async (payload) => { saved.push(payload); return { uid: 8, folder: 'Drafts' }; };
  useStore.setState({
    user: { id: 'u1' },
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
  });
});

describe('reopening a draft saved by another client', () => {
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT }); });
  after(() => close());

  test('mounts the draft into the editor', () => {
    const editor = document.querySelector('.ProseMirror')?.editor;
    assert.ok(editor, 'the rich-text editor mounted');
    assert.match(editor.getHTML(), /The contract is attached\./);
    assert.notEqual(editor.getHTML(), GMAIL_DRAFT, 'precondition: TipTap rewrote the stored HTML');
  });

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });

  test('still autosaves once the body is edited, replacing the same draft', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'a real edit is saved');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.match(saved[0].body, /Thanks\./);
  });
});

describe('reopening a draft in plain-text mode', () => {
  // The editor still mounts in plain-text mode, but the dirty check compares the textarea, so
  // its baseline has to stay the raw body.
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: true, body: 'Hi Bob,\n\nThe contract is attached.' }); });
  after(() => close());

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });
});

describe('switching From on a reopened draft', () => {
  // The old copy stays in the account it was saved to. The backend used to delete its uid in
  // whichever account From named, which expunged an unrelated message there when both
  // accounts have a Drafts folder.
  let close;
  before(async () => {
    useStore.setState({
      accounts: [
        { id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' },
        { id: 'other', enabled: true, email_address: 'other@example.invalid', name: 'Other', color: '#000' },
      ],
    });
    close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT });
  });
  after(() => close());

  test('names the account that holds the copy being replaced', async () => {
    const from = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'account:other'));
    await React.act(async () => {
      from.value = 'account:other';
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'the edit is saved');
    assert.equal(saved[0].accountId, 'other', 'the new copy goes to the account From names');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.equal(saved[0].existingAccountId, 'acct', 'the old copy is deleted from its own account');
  });

  test('the next save replaces the new copy in the account it was saved to', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Bye.'); });
    await hideTab();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].existingUid, 8);
    assert.equal(saved[0].existingAccountId, 'other');
  });
});

describe('sending or discarding while a draft save is still running', () => {
  // Send and Discard delete the draft copy as the composer closes. A save that returns after
  // that has appended a newer copy, and unless they wait for it, that copy stays in Drafts: a
  // sent message then looks unsent, and a discarded draft comes back.
  const original = {};
  let calls, pendingSave, pendingSend;

  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  // Mounted the way MailApp mounts it, so closeCompose() unmounts the composer as it does there.
  function Host() {
    return useStore(s => s.composing) ? React.createElement(ComposeModal) : null;
  }

  async function open(data) {
    calls = { saved: [], sent: [], deleted: [] };
    useStore.setState({
      plaintextEmail: false,
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
    });
    useStore.getState().openCompose({
      accountId: 'acct',
      to: ['Bob <bob@example.invalid>'],
      cc: [],
      subject: 'Lunch',
      body: '<p>Hi Bob</p>',
      bodyIsHtml: true,
      ...data,
    });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    return () => React.act(async () => root.unmount());
  }

  async function editAndAutosave() {
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Friday?'); });
    await hideTab();
    assert.equal(calls.saved.length, 1, 'precondition: a draft save is running');
    return editor;
  }

  // useEditor destroys the editor a tick after unmount, and a real save returns long after that.
  async function waitForDestroy(editor) {
    await React.act(() => new Promise(resolve => setTimeout(resolve, 10)));
    assert.ok(editor.isDestroyed, 'precondition: the editor was destroyed');
  }

  async function click(match) {
    const button = [...document.querySelectorAll('button')].find(match);
    assert.ok(button, 'button found');
    await React.act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  }

  const clickSend = () => click(b => b.textContent.includes('compose.send'));
  const composerOpen = () => document.querySelector('.ProseMirror') != null;

  before(() => {
    Object.assign(original, { saveDraft: api.saveDraft, post: api.post, deleteDraft: api.deleteDraft });
    api.saveDraft = (payload) => { calls.saved.push(payload); pendingSave = deferred(); return pendingSave.promise; };
    api.post = (path) => { calls.sent.push(path); pendingSend = deferred(); return pendingSend.promise; };
    api.deleteDraft = async (...args) => { calls.deleted.push(args); return { ok: true }; };
  });
  after(() => { Object.assign(api, original); });

  test('Send deletes the copy a save appends after the composer has closed', async () => {
    const close = await open({});
    try {
      const editor = await editAndAutosave();
      await clickSend();
      assert.deepEqual(calls.sent, ['/mail/send']);
      await React.act(async () => { pendingSend.resolve({ sentFolder: 'Sent' }); });
      assert.equal(composerOpen(), false, 'precondition: the send closed the composer');
      await waitForDestroy(editor);
      await React.act(async () => { pendingSave.resolve({ uid: 9, folder: 'Drafts' }); });
      assert.deepEqual(calls.deleted, [['acct', 9, 'Drafts']], 'the sent message must not stay in Drafts');
    } finally { await close(); }
  });

  test('Send deletes the copy that replaced the reopened draft, not the one it replaced', async () => {
    // The save route deletes uid 7 itself once uid 9 is stored.
    const close = await open({ draftUid: 7, draftFolder: 'Drafts' });
    try {
      await editAndAutosave();
      assert.equal(calls.saved[0].existingUid, 7);
      await clickSend();
      await React.act(async () => { pendingSave.resolve({ uid: 9, folder: 'Drafts' }); });
      await React.act(async () => { pendingSend.resolve({ sentFolder: 'Sent' }); });
      assert.equal(composerOpen(), false);
      assert.deepEqual(calls.deleted, [['acct', 9, 'Drafts']]);
    } finally { await close(); }
  });

  test('Send on a reopened draft deletes the copy a save appends after the composer has closed', async () => {
    // uid 7 is known from the start, but the copy to delete is the one the save returns.
    const close = await open({ draftUid: 7, draftFolder: 'Drafts' });
    try {
      const editor = await editAndAutosave();
      await clickSend();
      await React.act(async () => { pendingSend.resolve({ sentFolder: 'Sent' }); });
      assert.equal(composerOpen(), false, 'precondition: the send closed the composer');
      await waitForDestroy(editor);
      await React.act(async () => { pendingSave.resolve({ uid: 9, folder: 'Drafts' }); });
      assert.deepEqual(calls.deleted, [['acct', 9, 'Drafts']]);
    } finally { await close(); }
  });

  test('Send with no save running deletes the draft it was opened from', async () => {
    const close = await open({ draftUid: 7, draftFolder: 'Drafts' });
    try {
      await clickSend();
      await React.act(async () => { pendingSend.resolve({ sentFolder: 'Sent' }); });
      assert.deepEqual(calls.saved, []);
      assert.deepEqual(calls.deleted, [['acct', 7, 'Drafts']]);
    } finally { await close(); }
  });

  test('Send after a save that failed deletes the draft it was opened from', async () => {
    // A failed save appended nothing, so uid 7 is still the only copy.
    const close = await open({ draftUid: 7, draftFolder: 'Drafts' });
    try {
      await editAndAutosave();
      await clickSend();
      await React.act(async () => { pendingSave.reject(new Error('Save failed')); });
      await React.act(async () => { pendingSend.resolve({ sentFolder: 'Sent' }); });
      assert.equal(composerOpen(), false);
      assert.deepEqual(calls.deleted, [['acct', 7, 'Drafts']]);
    } finally { await close(); }
  });

  test('A send that fails deletes nothing, even once the save returns', async () => {
    const close = await open({ draftUid: 7, draftFolder: 'Drafts' });
    try {
      await editAndAutosave();
      await clickSend();
      await React.act(async () => { pendingSend.reject(new Error('Send failed')); });
      await React.act(async () => { pendingSave.resolve({ uid: 9, folder: 'Drafts' }); });
      assert.equal(composerOpen(), true, 'precondition: the composer stayed open to try again');
      assert.deepEqual(calls.deleted, []);
    } finally {
      await close();
      useStore.getState().closeCompose();
    }
  });

  test('Discard deletes the copy a save appends after the composer has closed', async () => {
    const close = await open({});
    try {
      const editor = await editAndAutosave();
      await click(b => b.title === 'compose.toolbar.close');
      await click(b => b.textContent === 'compose.closeDraft.discard');
      assert.equal(composerOpen(), false, 'precondition: discarding closed the composer');
      await waitForDestroy(editor);
      await React.act(async () => { pendingSave.resolve({ uid: 9, folder: 'Drafts' }); });
      assert.deepEqual(calls.deleted, [['acct', 9, 'Drafts']], 'a discarded draft must not come back');
    } finally { await close(); }
  });

  test('Discard on a phone deletes the copy a save appends after the composer has closed', async () => {
    const width = window.innerWidth;
    window.innerWidth = 375;
    const close = await open({});
    try {
      const editor = await editAndAutosave();
      await click(b => b.textContent === 'common.cancel');
      await click(b => b.textContent === 'compose.closeDraft.discard');
      assert.equal(composerOpen(), false, 'precondition: discarding closed the composer');
      await waitForDestroy(editor);
      await React.act(async () => { pendingSave.resolve({ uid: 9, folder: 'Drafts' }); });
      assert.deepEqual(calls.deleted, [['acct', 9, 'Drafts']], 'a discarded draft must not come back');
    } finally {
      await close();
      window.innerWidth = width;
    }
  });
});
