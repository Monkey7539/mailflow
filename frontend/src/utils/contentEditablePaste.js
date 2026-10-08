import DOMPurify from 'dompurify';

// Paste into the composer's signature and quoted-reply areas, and the signature editor in
// Settings, without the colours of the page the text was copied from.
//
// These are plain contenteditables, so a paste is the browser's own, and Chrome and Safari copy
// each run with the styles in effect where it sat. Text copied out of an email arrives with the
// frame's white page and #1a1a1a text, on the spans of a phrase and on every <p> of a longer
// copy: dark text in a white box on the dark theme, and a box the recipient gets too.
//
// So the colours go. The text colour goes with the background it was chosen for: without it,
// #1a1a1a is unreadable on the dark theme, and near-white text copied from MailFlow's own dark
// screens would be invisible to a recipient reading on white. A highlight cannot be kept apart
// from the page behind it, because the browser writes both the same way. Bold, links, fonts,
// sizes and images survive, and the Settings editor's colour button and source view can put
// colours back. HTML that ProseMirror put on the clipboard (data-pm-slice) was copied in the
// composer's own editor, so its colours are ones the user applied and stay.
//
// The page inserts the HTML itself, so it is sanitised first, as the browser's paste would be,
// and <style> blocks are dropped because they would restyle the app around the editor.

// mso-highlight is how Word writes a highlight, which Outlook still renders.
const COLOR_PROPERTIES = new Set(['color', 'background-color', '-webkit-text-fill-color', 'mso-highlight']);

// Pieces are rejoined with the semicolons they were split on, so one inside a url() survives.
function withoutColors(style) {
  return style.split(';').filter(declaration => {
    const colon = declaration.indexOf(':');
    if (colon < 0) return declaration.trim() !== '';
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (COLOR_PROPERTIES.has(property)) return false;
    // The shorthand is how Outlook writes a background colour. One that carries an image stays.
    return property !== 'background' || /url\(/i.test(declaration);
  }).join(';').trim();
}

export function cleanPastedHtml(html) {
  const fragment = DOMPurify.sanitize(html, { FORBID_TAGS: ['style'], RETURN_DOM_FRAGMENT: true });
  if (!/\sdata-pm-slice=/.test(html)) {
    for (const el of fragment.querySelectorAll('*')) {
      el.removeAttribute('bgcolor');
      if (el.localName === 'font') el.removeAttribute('color');
      const style = el.getAttribute('style');
      if (style === null) continue;
      const kept = withoutColors(style);
      if (kept) el.setAttribute('style', kept);
      else el.removeAttribute('style');
    }
  }
  const box = document.createElement('div');
  box.appendChild(fragment);
  return box.innerHTML;
}

export function pasteWithoutColors(event) {
  const html = event.clipboardData?.getData('text/html');
  if (!html) return;
  const clean = cleanPastedHtml(html);
  if (!clean.trim()) return;
  // insertHTML keeps the paste on the undo stack and fires the input event the editors save
  // from. If it ever refuses, the browser's own paste goes ahead rather than losing the text.
  if (typeof document.execCommand === 'function' && document.execCommand('insertHTML', false, clean)) {
    event.preventDefault();
  }
}
