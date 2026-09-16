// The AI writing actions' round trip through the real composer editor: the body read out as
// text, a reply written back by Apply. Booted against jsdom like editorLink.editor.test.js,
// because what matters is the HTML the editor ends up holding, not the helper's return values.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Tiptap reads browser globals at import time, so the DOM has to exist before it is imported.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'https://mailflow.test/',
});
const { window } = dom;
for (const key of [
  'window', 'document', 'DOMParser', 'Node', 'Element', 'HTMLElement', 'Event',
  'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'Range', 'getComputedStyle',
]) {
  Object.defineProperty(globalThis, key, {
    value: key === 'window' ? window : window[key],
    configurable: true,
    writable: true,
  });
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const { Editor } = await import('@tiptap/core');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { TextStyle, Color, FontFamily, FontSize } = await import('@tiptap/extension-text-style');
const { editorTextForAi, sharedTextStyle, aiTextToDoc } = await import('./aiComposeText.js');

const editors = [];
function makeEditor(content = '') {
  const editor = new Editor({
    element: document.getElementById('root'),
    extensions: [StarterKit.configure({ link: false }), TextStyle, Color, FontFamily, FontSize],
    content,
  });
  editors.push(editor);
  return editor;
}
after(() => { for (const editor of editors) editor.destroy(); });

// What ComposeModal's applyAiText does.
function apply(editor, reply) {
  const { doc, storedMarks } = editor.state;
  editor.commands.setContent(aiTextToDoc(reply, sharedTextStyle(doc, storedMarks)));
}

const TYPED = '<p>Hi Bob,</p><p></p><p>Thanks for Tuesday.</p><p>See you at the rink.</p><p></p><p>Thanks,</p>';

describe('blank lines through Improve and Apply', () => {
  test('the model sees a blank line only where the email has one', () => {
    assert.equal(
      editorTextForAi(makeEditor(TYPED).state.doc),
      'Hi Bob,\n\nThanks for Tuesday.\nSee you at the rink.\n\nThanks,',
    );
  });

  test('applying the text unchanged keeps every line and blank line of the typed email', () => {
    const editor = makeEditor(TYPED);
    apply(editor, editorTextForAi(editor.state.doc));
    // Lines one Enter apart come back as line breaks: they look the same in the composer, and in
    // sent mail they stay together as they did before, instead of each gaining a paragraph margin.
    assert.equal(
      editor.getHTML(),
      '<p>Hi Bob,</p><p></p><p>Thanks for Tuesday.<br>See you at the rink.</p><p></p><p>Thanks,</p>',
    );
    assert.equal(editorTextForAi(editor.state.doc), editorTextForAi(makeEditor(TYPED).state.doc));
  });

  test("a reply's blank lines become empty paragraphs, which is how the composer spaces text", () => {
    const editor = makeEditor('<p>hi bob thanks for tuesday</p>');
    apply(editor, 'Hi Bob,\n\nThank you for Tuesday.\n\n\nThanks,');
    assert.equal(editor.getHTML(), '<p>Hi Bob,</p><p></p><p>Thank you for Tuesday.</p><p></p><p></p><p>Thanks,</p>');
  });

  test("a reply's single line breaks stay line breaks, so a sign-off pair is sent together", () => {
    const editor = makeEditor();
    apply(editor, 'See you Friday.\n\nThanks,\nJordan');
    assert.equal(editor.getHTML(), '<p>See you Friday.</p><p></p><p>Thanks,<br>Jordan</p>');
  });

  test('a line break inside a paragraph is its own line', () => {
    assert.equal(editorTextForAi(makeEditor('<p>Line one<br>Line two</p>').state.doc), 'Line one\nLine two');
  });

  test('whitespace around the reply and Windows line endings are dropped', () => {
    const editor = makeEditor();
    apply(editor, '\r\n\r\n  Hi Bob,  \r\n\r\nThanks,\r\n\r\n');
    assert.equal(editor.getHTML(), '<p>Hi Bob,</p><p></p><p>Thanks,</p>');
  });

  test('lists are one line per item, not items padded with blank lines', () => {
    const doc = makeEditor(
      '<p>Bring:</p><ul><li><p>Skates</p></li><li><p>Helmet</p><ul><li><p>with cage</p></li></ul></li></ul>'
      + '<ol start="3"><li><p>Warm up</p></li><li><p>Drills</p></li></ol>',
    ).state.doc;
    assert.equal(editorTextForAi(doc), 'Bring:\n- Skates\n- Helmet\n  - with cage\n3. Warm up\n4. Drills');
  });

  test('a horizontal rule reads as a blank line, so the paragraphs around it stay apart', () => {
    assert.equal(editorTextForAi(makeEditor('<p>Above</p><hr><p>Below</p>').state.doc), 'Above\n\nBelow');
  });
});

describe('text and font through Apply', () => {
  test('text that looks like HTML stays in the email as text', () => {
    const editor = makeEditor();
    apply(editor, 'Contact Jane <jane@example.com> for R&D <b>today</b>.');
    assert.equal(editor.getText(), 'Contact Jane <jane@example.com> for R&D <b>today</b>.');
  });

  test("keeps the composer's font on the rewritten text", () => {
    const editor = makeEditor(
      '<p><span style="font-family: Georgia; font-size: 14px">hi bob</span></p><p></p>'
      + '<p><span style="font-family: Georgia; font-size: 14px">thanks</span></p>',
    );
    apply(editor, 'Hi Bob,\n\nThanks,\nJordan');
    assert.equal(
      editor.getHTML(),
      '<p><span style="font-family: Georgia; font-size: 14px;">Hi Bob,</span></p><p></p>'
      + '<p><span style="font-family: Georgia; font-size: 14px;">Thanks,</span><br>'
      + '<span style="font-family: Georgia; font-size: 14px;">Jordan</span></p>',
    );
  });

  test('a style on only part of the body is not spread over the whole reply', () => {
    const editor = makeEditor('<p><span style="font-size: 14px; color: #e03131">Urgent:</span><span style="font-size: 14px"> ice is down</span></p>');
    apply(editor, 'Urgent: the ice is down.');
    assert.equal(editor.getHTML(), '<p><span style="font-size: 14px;">Urgent: the ice is down.</span></p>');
  });

  test('an empty compose (Draft) uses the default font the composer set for typing', () => {
    const editor = makeEditor();
    editor.commands.setFontSize('14px');
    apply(editor, 'Hi Bob,');
    assert.equal(editor.getHTML(), '<p><span style="font-size: 14px;">Hi Bob,</span></p>');
  });

  test('an unstyled body stays unstyled', () => {
    const editor = makeEditor('<p>hi</p>');
    apply(editor, 'Hi.');
    assert.equal(editor.getHTML(), '<p>Hi.</p>');
  });

  test('an empty reply leaves one empty paragraph', () => {
    assert.deepEqual(aiTextToDoc('\n\n'), { type: 'doc', content: [{ type: 'paragraph' }] });
  });
});
