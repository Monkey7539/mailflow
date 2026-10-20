// Email HTML placed in MailFlow's own page (the composer's quote, the div renderer) keeps images
// only from MailFlow itself. The CSS escape cases depend on the browser's CSS parser and are checked
// in Chromium, Firefox and WebKit; jsdom covers the URL handling and what must be kept.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the window it finds when it is first imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mail.example.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { sanitizeEmailForApp } = await import('./appEmailHtml.js');
const DOMPurify = (await import('dompurify')).default;

const parse = html => new dom.window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;

describe('sanitizeEmailForApp', () => {
  it("drops a sender's image, written plainly or with a line break in its scheme", () => {
    const out = parse(sanitizeEmailForApp('<img id="a" src="https://evil.example/a.gif"><img id="b" src="ht\ntps://evil.example/b.gif"><td id="c" background="https://evil.example/c.gif">x</td>'));
    assert.equal(out.querySelector('#a').hasAttribute('src'), false);
    assert.equal(out.querySelector('#b').hasAttribute('src'), false);
  });

  it('drops a srcset with any remote candidate, and an SVG image from the sender', () => {
    const out = parse(sanitizeEmailForApp('<img id="s" srcset="/api/mail/messages/1/image?u=a 1x, https://evil.example/s.png 2x"><svg><image id="v" href="https://evil.example/v.png"></image></svg>'));
    assert.equal(out.querySelector('#s').hasAttribute('srcset'), false);
    assert.equal(out.querySelector('#v')?.hasAttribute('href') ?? false, false);
  });

  it("keeps MailFlow's own images, data: and cid: images, and ordinary styling", () => {
    const out = parse(sanitizeEmailForApp('<img id="p" src="/api/mail/messages/1/image?u=abc"><img id="d" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><img id="c" src="cid:logo@x"><p id="t" style="color: red; font-weight: bold">Hi</p>'));
    assert.equal(out.querySelector('#p').getAttribute('src'), '/api/mail/messages/1/image?u=abc');
    assert.ok(out.querySelector('#d').getAttribute('src').startsWith('data:'));
    assert.equal(out.querySelector('#c').getAttribute('src'), 'cid:logo@x');
    assert.equal(out.querySelector('#t').style.color, 'red');
    assert.equal(out.querySelector('#t').style.fontWeight, 'bold');
  });

  it("drops a style declaration that loads from the sender and keeps the rest", () => {
    const out = parse(sanitizeEmailForApp('<div id="x" style="color: red; background-image: url(https://evil.example/bg.gif)">x</div>'));
    assert.equal(out.querySelector('#x').style.backgroundImage, '');
    assert.equal(out.querySelector('#x').style.color, 'red');
  });

  // #640: an image a table names as its background by cid: or Content-Location reaches the page as
  // a data: URI, and the email frame shows it. The quoted reply or forward and the div renderer
  // dropped it, since DOMPurify allows data: only in a media element's src.
  it('keeps a base64 raster image in the background of a table, row or cell, as the email frame does', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const html = `<table id="t" background="${png}"><tr id="r" background="data:image/JPEG;base64,/9j/"><td id="d" background="${png}">x</td><th id="h" background="${png}">y</th></tr></table>`;
    // The composer's quote, then the div renderer.
    for (const config of [{ FORBID_TAGS: ['style'] }, { ADD_ATTR: ['target'], FORBID_TAGS: ['style'] }]) {
      const out = parse(sanitizeEmailForApp(html, config));
      assert.equal(out.querySelector('#t').getAttribute('background'), png);
      assert.equal(out.querySelector('#r').getAttribute('background'), 'data:image/JPEG;base64,/9j/');
      assert.equal(out.querySelector('#d').getAttribute('background'), png);
      assert.equal(out.querySelector('#h').getAttribute('background'), png);
    }
  });

  it('drops any other data: background, a data: background on another tag, and a remote one', () => {
    for (const value of [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png,<svg onload=alert(1)>',
      'data:image/png;base64,AA" onload="alert(1)',
      ' data:application/javascript;base64,YWxlcnQoMSk=',
      'https://evil.example/bg.gif',
    ]) {
      const out = parse(sanitizeEmailForApp(`<table id="t" background='${value}'><tr><td>x</td></tr></table>`));
      assert.equal(out.querySelector('#t').hasAttribute('background'), false, value);
    }
    const div = parse(sanitizeEmailForApp('<div id="v" background="data:image/png;base64,iVBORw0KGgo=">x</div>'));
    assert.equal(div.querySelector('#v').hasAttribute('background'), false);
    const cid = parse(sanitizeEmailForApp('<table id="c" background="cid:bg@x"><tr><td>x</td></tr></table>'));
    assert.equal(cid.querySelector('#c').getAttribute('background'), 'cid:bg@x');
  });

  it('leaves other sanitizes alone', () => {
    sanitizeEmailForApp('<p>x</p>');
    assert.match(DOMPurify.sanitize('<img src="https://example.com/a.png">'), /https:\/\/example\.com\/a\.png/);
    assert.doesNotMatch(DOMPurify.sanitize('<table background="data:image/png;base64,iVBORw0KGgo="><tr><td>x</td></tr></table>'), /background/);
  });
});
