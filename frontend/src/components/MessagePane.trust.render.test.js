// Render test for the sender-trust badge in the message header.
//
// The loader hook and jsdom setup below are the same ones MessagePane.render.test.js uses; this
// file keeps its own copy so the upstream test stays untouched. What is different here is the
// fetch stub, which answers the trust endpoint with a real assessment so the badge has something
// to show, and the assertions, which drive the popover the way a user does.
//
// react-i18next is stubbed so t() returns the key it was given — assertions therefore look for
// key strings such as "trust.badge.caution" rather than English.

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
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const TRUST = {
  level: 'caution',
  auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', dkimDomain: 'example.net' },
  spam: { score: 3.03, threshold: 15, engine: 'rspamd' },
  flags: [{ id: 'phishSymbols', severity: 'warn', symbols: 'BAD_REP_POLICIES' }],
};

let trustPayload = TRUST;
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  text: async () => '',
  json: async () => (String(url).endsWith('/trust') ? trustPayload : {}),
});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessagePane = (await import('./MessagePane.jsx')).default;

const MSG = {
  id: 'a1', account_id: 'acct', folder: 'INBOX', uid: 1, subject: 'Welcome',
  from_email: 'x@y.z', from_name: 'X', date: new Date().toISOString(),
  is_read: true, to_addresses: [], cc_addresses: [],
};

const html = () => document.getElementById('root').innerHTML;
const badge = () => document.querySelector('button[data-trust]');
const panel = () => document.querySelector('[role="dialog"]');

let root;
before(async () => {
  useStore.getState().setUser({ id: 'u1' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts([{ id: 'acct', enabled: true, email_address: 'x@y.z', color: '#fff' }]);
  useStore.getState().setMessages?.([MSG]);
  root = createRoot(document.getElementById('root'));
  useStore.getState().setSelectedMessage('a1');
  await React.act(async () => { root.render(React.createElement(MessagePane)); });
});
after(async () => { await React.act(async () => root.unmount()); });

describe('sender-trust badge', () => {
  test('shows the level as a badge and keeps the detail hidden until asked', async () => {
    assert.ok(badge(), 'the header renders a trust badge');
    assert.match(html(), /trust\.badge\.caution/, 'the badge carries the short level label');
    assert.doesNotMatch(html(), /trust\.flags\.phishSymbols/, 'findings stay closed until the badge is clicked');
  });

  test('clicking the badge opens the findings the old strip used to show', async () => {
    await React.act(async () => {
      badge().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const open = html();
    assert.match(open, /trust\.caution/, 'the level title');
    assert.match(open, /trust\.flags\.phishSymbols/, 'every flag');
    assert.match(open, /trust\.auth\.spf/, 'the authentication summary');
    assert.match(open, /trust\.spamScore/, 'the spam score');
    assert.equal(badge().getAttribute('aria-expanded'), 'true');
  });

  test('Escape closes it again and puts focus back on the badge', async () => {
    await React.act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.doesNotMatch(html(), /trust\.flags\.phishSymbols/);
    assert.equal(badge().getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, badge(), 'focus returns to the trigger');
  });

  test('its own scrollbar does not dismiss it, but scrolling the pane does', async () => {
    // The listener runs in the capture phase, because the pane scrolls in its own
    // container rather than the window — which means it also hears the panel.
    await React.act(async () => {
      badge().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.ok(panel(), 'open');
    await React.act(async () => {
      panel().dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    });
    assert.ok(panel(), 'scrolling a long finding list inside the panel keeps it open');
    await React.act(async () => {
      document.body.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    });
    assert.equal(panel(), null, 'scrolling the message pane closes it');
  });

  test('the panel is placed in the scaled wrapper\'s space, not visual space', async () => {
    // The app renders inside a transform: scale() wrapper, so a coordinate measured
    // from getBoundingClientRect has to be divided back out or the panel drifts off
    // its badge. jsdom lays nothing out, so the measured top is 0 + the 6px gap.
    await React.act(async () => { badge().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.equal(panel().style.top, '6px', 'at 100% the conversion is a no-op');
    await React.act(async () => {
      document.body.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
      useStore.getState().setFontSize(150);
    });
    await React.act(async () => { badge().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.equal(panel().style.top, '4px', 'at 150% it is divided by the scale');
    await React.act(async () => {
      document.body.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
      useStore.getState().setFontSize(100);
    });
  });

  test('a dangerous assessment carries the red level through to the badge', async () => {
    trustPayload = { ...TRUST, level: 'danger', flags: [{ id: 'spamHigh', severity: 'danger', score: 18, threshold: 15 }] };
    await React.act(async () => { useStore.getState().setSelectedMessage(null); });
    await React.act(async () => { useStore.getState().setSelectedMessage('a1'); });
    assert.equal(badge().getAttribute('data-trust'), 'danger');
    assert.match(html(), /trust\.badge\.danger/);
    trustPayload = TRUST;
  });

  test('an assessment with no level renders no badge at all', async () => {
    // A failed or truncated response must not take the header down with it.
    trustPayload = {};
    await React.act(async () => { useStore.getState().setSelectedMessage(null); });
    await React.act(async () => { useStore.getState().setSelectedMessage('a1'); });
    assert.equal(badge(), null, 'no badge without a level');
    assert.ok(html().length > 0, 'and the pane still renders');
    trustPayload = TRUST;
  });
});
