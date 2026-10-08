// Tests for pasting into the plain contenteditables (contentEditablePaste.js).
//
// The Chrome clipboard contents below are what Chrome 152 wrote for selections in an email
// rendered in MessageBodyView's frame, captured from a drag of each selection, which Chrome
// serialises with the same code as a copy. The plain editors keep every inline style, so unlike
// the composer's TipTap editor they also keep the colours a copy of several paragraphs puts on
// each <p>.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the window it finds when it is first imported, so the DOM comes first.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mailflow.test/' });
for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'DocumentFragment']) {
  Object.defineProperty(globalThis, key, {
    value: key === 'window' ? dom.window : dom.window[key],
    configurable: true,
    writable: true,
  });
}

const { cleanPastedHtml, pasteWithoutColors } = await import('./contentEditablePaste.js');

const NBSP = String.fromCharCode(160);
// The styles Chrome writes for each copied run: everything in effect where the text sat.
const inEffect = (color, background) => `color: ${color}; font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: ${background}; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;`;
// MessageBodyView's frame: a white page with #1a1a1a text. A run of text also gets display and float.
const PAGE = inEffect('rgb(26, 26, 26)', 'rgb(255, 255, 255)');
const RUN = `${PAGE} display: inline !important; float: none;`;

const PHRASE = `<meta charset='utf-8'><span style="${RUN}">ice resurfacer is booked for</span>`;
const PARAGRAPHS = `<meta charset='utf-8'><p id="p1" style="${PAGE}">Hi Marty,</p><p id="p2" style="${PAGE}">The ice resurfacer is booked for<span>${NBSP}</span><b>Tuesday at 6am</b>. Details are on<span>${NBSP}</span><a rel="noopener noreferrer" href="https://example.com/schedule" style="color: rgb(99, 102, 241);">the schedule page</a>.</p>`;
const DARK_BLOCK = `<meta charset='utf-8'><span style="${inEffect('rgb(255, 255, 255)', 'rgb(17, 17, 17)')} display: inline !important; float: none;">Dark newsletter text block</span>`;
const LINE_WITH_HIGHLIGHT = `<meta charset='utf-8'><span style="${RUN}">Please note:<span>${NBSP}</span></span><span id="hl" style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; background-color: rgb(255, 255, 0);">the rink opens late</span><span style="${RUN}"><span>${NBSP}</span>on Friday.</span>`;

// Parse cleaned HTML back into elements, to read attributes the way the editor will hold them.
function parse(html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  return box;
}

// Every colour the cleaned HTML still carries, from style declarations and colour attributes.
function colours(html) {
  const found = [];
  for (const el of parse(html).querySelectorAll('*')) {
    const style = el.getAttribute('style') || '';
    found.push(...(style.match(/(?:background(?:-color)?|(?<![\w-])color|-webkit-text-fill-color|mso-highlight)\s*:[^;]*/gi) || []));
    if (el.hasAttribute('bgcolor')) found.push(`bgcolor=${el.getAttribute('bgcolor')}`);
    if (el.localName === 'font' && el.hasAttribute('color')) found.push(`font color=${el.getAttribute('color')}`);
  }
  return found;
}

const text = html => parse(html).textContent.replaceAll(NBSP, ' ');

describe('cleanPastedHtml: text copied from an email', () => {
  test('a phrase loses the white page and the dark text, and keeps its font', () => {
    const html = cleanPastedHtml(PHRASE);
    assert.equal(text(html), 'ice resurfacer is booked for');
    assert.deepEqual(colours(html), []);
    assert.match(parse(html).querySelector('span').getAttribute('style'), /font-family: -apple-system, Arial, sans-serif/);
  });

  test('paragraphs lose the colours on each <p>, and keep their bold text and link', () => {
    const html = cleanPastedHtml(PARAGRAPHS);
    const box = parse(html);
    assert.equal(box.querySelectorAll('p').length, 2);
    assert.equal(text(html), 'Hi Marty,The ice resurfacer is booked for Tuesday at 6am. Details are on the schedule page.');
    assert.equal(box.querySelector('b').textContent, 'Tuesday at 6am');
    assert.equal(box.querySelector('a').getAttribute('href'), 'https://example.com/schedule');
    assert.deepEqual(colours(html), []);
  });

  test('white text from a dark block does not stay white', () => {
    const html = cleanPastedHtml(DARK_BLOCK);
    assert.equal(text(html), 'Dark newsletter text block');
    assert.deepEqual(colours(html), []);
  });

  test('a highlight goes with the page around it', () => {
    const html = cleanPastedHtml(LINE_WITH_HIGHLIGHT);
    assert.equal(text(html), 'Please note: the rink opens late on Friday.');
    assert.deepEqual(colours(html), []);
  });
});

describe('cleanPastedHtml: other ways colour arrives', () => {
  test('Outlook and Word backgrounds and highlights, cell colours and <font color> go', () => {
    const html = cleanPastedHtml(
      '<p class="MsoNormal"><span style="background:white;mso-highlight:white;color:black">Outlook text</span></p>'
      + '<table><tr><td bgcolor="#f2f2f2" style="background:#F2F2F2;padding:4px">cell</td></tr></table>'
      + '<font color="#c00000" face="Arial">red</font><span style="-webkit-text-fill-color: #111">filled</span>',
    );
    assert.deepEqual(colours(html), []);
    const box = parse(html);
    assert.equal(box.querySelector('p').className, 'MsoNormal');
    assert.equal(box.querySelector('td').getAttribute('style'), 'padding:4px');
    assert.equal(box.querySelector('font').getAttribute('face'), 'Arial');
  });

  test('a background image stays, with the semicolons inside it', () => {
    const html = cleanPastedHtml(
      '<span style=\'background-image: url("data:image/png;base64,AAAA"); color: red\'>logo</span>'
      + '<div style="background: url(https://example.com/bar.png) no-repeat">bar</div>',
    );
    const box = parse(html);
    assert.equal(box.querySelector('span').getAttribute('style'), 'background-image: url("data:image/png;base64,AAAA")');
    assert.equal(box.querySelector('div').getAttribute('style'), 'background: url(https://example.com/bar.png) no-repeat');
  });

  test('a span that carried only colours keeps no empty style attribute', () => {
    const html = cleanPastedHtml('<span style="color:#000000;background-color:transparent">plain words</span>');
    assert.equal(html, '<span>plain words</span>');
  });
});

describe('cleanPastedHtml: what the page now inserts itself', () => {
  test('scripts, event handlers, javascript: links and <style> blocks do not get in', () => {
    // The <style> comes after content, where Google Sheets puts it; a leading one would be parsed
    // into <head> and dropped regardless.
    const html = cleanPastedHtml(
      '<p onclick="steal()">a</p><style>body{display:none}</style><img src="x.png" onerror="steal()">'
      + '<a href="javascript:steal()">b</a><script>steal()</script>',
    );
    assert.doesNotMatch(html, /<style|onclick|onerror|javascript:|<script|steal/i);
    assert.equal(parse(html).querySelector('img').getAttribute('src'), 'x.png');
  });

  test('HTML copied in the composer\'s own editor keeps its colours', () => {
    const html = cleanPastedHtml('<p data-pm-slice="1 1 []">keep <span style="background-color: #ffd43b">this highlight</span></p>');
    assert.deepEqual(colours(html), ['background-color: #ffd43b']);
  });
});

describe('pasteWithoutColors', () => {
  // jsdom has no editing commands, so insertHTML is a recording stand-in.
  function pasteEvent(data) {
    const event = { prevented: false, clipboardData: { getData: type => data[type] ?? '' } };
    event.preventDefault = () => { event.prevented = true; };
    return event;
  }
  function withExecCommand(result, run) {
    const calls = [];
    document.execCommand = (...args) => { calls.push(args); return result; };
    try { run(calls); } finally { delete document.execCommand; }
  }

  test('inserts the cleaned HTML and cancels the browser\'s own paste', () => {
    withExecCommand(true, calls => {
      const event = pasteEvent({ 'text/html': PHRASE, 'text/plain': 'ice resurfacer is booked for' });
      pasteWithoutColors(event);
      assert.equal(calls.length, 1);
      const [command, showUi, html] = calls[0];
      assert.equal(command, 'insertHTML');
      assert.equal(showUi, false);
      assert.equal(text(html), 'ice resurfacer is booked for');
      assert.deepEqual(colours(html), []);
      assert.equal(event.prevented, true);
    });
  });

  test('leaves a paste without HTML to the browser', () => {
    withExecCommand(true, calls => {
      const event = pasteEvent({ 'text/plain': 'just text' });
      pasteWithoutColors(event);
      assert.equal(calls.length, 0);
      assert.equal(event.prevented, false);
    });
  });

  test('lets the browser paste when insertHTML refuses, rather than losing the text', () => {
    withExecCommand(false, calls => {
      const event = pasteEvent({ 'text/html': PHRASE });
      pasteWithoutColors(event);
      assert.equal(calls.length, 1);
      assert.equal(event.prevented, false);
    });
  });

  test('lets the browser paste when nothing is left after sanitising', () => {
    withExecCommand(true, calls => {
      const event = pasteEvent({ 'text/html': '<script>steal()</script>', 'text/plain': 'steal()' });
      pasteWithoutColors(event);
      assert.equal(calls.length, 0);
      assert.equal(event.prevented, false);
    });
  });
});
