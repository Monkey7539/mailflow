// Render test for Sign out on the lock screen.
//
// It has to do what the sidebar's Sign out does: follow the SSO end-session URL when the
// provider supports it (#310), clear the per-user keys and reload the page. Signing out inside
// the page leaves the provider session alive, so Sign in with SSO goes straight back into the
// mailbox that was locked. Harness as in ComposeModal.render.test.js.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
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

// jsdom only carries out same-document navigation. It reports a load of any other document
// here instead, without the URL, so these tests can count page loads but not see where they
// go. signOutState.test.js checks the fallback to /login.
const pageLoads = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
  if (e.type === 'not-implemented' && /navigation/.test(e.message)) pageLoads.push(e.message);
  else console.error(e);
});

const PAGE = 'https://mail.example.invalid/';
const dom = new JSDOM('<div id="root"></div>', { url: PAGE, pretendToBeVisual: true, virtualConsole });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const LockScreen = (await import('./LockScreen.jsx')).default;

let root;
beforeEach(async () => {
  pageLoads.length = 0;
  localStorage.setItem('mailflow_page_size', '100');
  localStorage.setItem('mailflow_expanded_accounts', '{"acct-a":true}');
  useStore.getState().setUser({ id: 'alice', username: 'alice' });
  useStore.getState().setLocked(true);
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(LockScreen)); });
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  localStorage.clear();
  window.location.href = PAGE;
});

async function pressSignOut() {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'lockScreen.signOut');
  await React.act(async () => { button.click(); });
  await React.act(async () => {});
}

test('Sign out on the lock screen ends the SSO session', async () => {
  // Differs from the page URL only in its fragment, so jsdom carries it out and it can be read back.
  const endSessionUrl = `${PAGE}#sso-end-session`;
  api.logout = async () => ({ ok: true, endSessionUrl });
  await pressSignOut();
  assert.equal(window.location.href, endSessionUrl);
});

test('and otherwise loads a new page, clearing the per-user keys', async () => {
  api.logout = async () => ({ ok: true, endSessionUrl: null });
  await pressSignOut();
  assert.equal(pageLoads.length, 1, 'a page load discards everything still held in memory');
  assert.equal(localStorage.getItem('mailflow_page_size'), null);
  assert.equal(localStorage.getItem('mailflow_expanded_accounts'), null);
  assert.equal(localStorage.getItem('mailflow_locked'), null);
  assert.equal(useStore.getState().user, null);
});
