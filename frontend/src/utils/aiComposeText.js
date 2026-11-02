// Moving the compose body to and from the AI writing actions (Improve, Shorten, Fix grammar,
// Draft) without losing its layout.
//
// The actions work on plain text. On the way out the body was read with editor.getText(), which
// puts a blank line between every pair of paragraphs, so an ordinary paragraph break and a real
// blank line (an empty paragraph, which is how the composer makes one) reached the model looking
// the same. On the way back, Apply turned the reply's blank lines into plain paragraph breaks,
// which the composer draws with almost no gap, so every blank line in the email was gone.
//
// Apply also parsed the reply as HTML without escaping it, so "Jane <jane@example.com>" lost the
// address as an unknown tag, and it dropped the composer's default font, leaving the rewritten
// body a different size from anything typed after it.
//
// So the model sees one line per paragraph or line break and an empty line for each empty
// paragraph. Apply maps a reply back the way the old code split it, lines joined by a single
// newline staying together as line breaks and a blank line starting a new paragraph, but also puts
// an empty paragraph where each blank line was. The sent mail keeps its old layout, because
// mail clients give a paragraph its own margin and an empty one no height (a "Thanks,\nJordan"
// pair still arrives together), while the composer now shows the blank lines. The reply goes in
// as a document, never as HTML.

const LIST_TYPES = new Set(['bulletList', 'orderedList']);

function textOf(textblock) {
  return textblock.textBetween(0, textblock.content.size, '\n',
    leaf => (leaf.type.name === 'hardBreak' ? '\n' : ''));
}

/**
 * The body as plain text: one line per paragraph or line break, an empty line for an empty
 * paragraph (or a horizontal rule), and list items as "- " or "1. " lines rather than paragraphs
 * padded with blank lines.
 * @param {import('prosemirror-model').Node} doc  editor.state.doc
 */
export function editorTextForAi(doc) {
  const lines = [];
  const visit = (node, indent) => {
    node.forEach(child => {
      if (child.isTextblock) {
        for (const line of textOf(child).split('\n')) lines.push(line ? indent + line : '');
      } else if (LIST_TYPES.has(child.type.name)) {
        let number = child.type.name === 'orderedList' ? (child.attrs.start ?? 1) : null;
        child.forEach(item => {
          const marker = number == null ? '- ' : `${number++}. `;
          const pad = indent + ' '.repeat(marker.length);
          const first = lines.length;
          visit(item, pad);
          if (lines.length === first) {
            lines.push(indent + marker.trimEnd());
          } else {
            const line = lines[first];
            lines[first] = indent + marker + (line.startsWith(pad) ? line.slice(pad.length) : line);
          }
        });
      } else if (child.type.name === 'horizontalRule') {
        lines.push('');
      } else if (!child.isLeaf) {
        visit(child, indent);
      }
    });
  };
  visit(doc, '');
  return lines.join('\n');
}

/**
 * The composer's text style (font, size, colour) when it covers every character of the body, as
 * marks for the rewritten text. A style on only part of the body is emphasis the rewrite no longer
 * lines up with, so it is not spread across the whole reply. An empty body falls back to the
 * style the composer set for new typing (its default font).
 */
export function sharedTextStyle(doc, storedMarks) {
  let shared = null;
  doc.descendants(node => {
    if (!node.isText) return;
    const attrs = node.marks.find(m => m.type.name === 'textStyle')?.attrs ?? {};
    shared = shared == null
      ? { ...attrs }
      : Object.fromEntries(Object.entries(shared).filter(([key, value]) => attrs[key] === value));
  });
  if (shared == null) shared = storedMarks?.find(m => m.type.name === 'textStyle')?.attrs ?? {};
  const attrs = Object.fromEntries(Object.entries(shared).filter(([, value]) => value != null));
  return Object.keys(attrs).length ? [{ type: 'textStyle', attrs }] : [];
}

/**
 * An AI reply as editor content, its text carrying `marks`: lines joined by a single newline form
 * one paragraph with line breaks, and each empty line is an empty paragraph that also ends the
 * paragraph before it. Whitespace around the reply is padding, not part of the email.
 */
export function aiTextToDoc(text, marks = []) {
  const content = [];
  let paragraph = null;
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').trim().split('\n')) {
    const line = raw.trimEnd();
    if (!line) {
      paragraph = null;
      content.push({ type: 'paragraph' });
      continue;
    }
    const node = { type: 'text', text: line, ...(marks.length ? { marks } : {}) };
    if (paragraph) {
      paragraph.content.push({ type: 'hardBreak' }, node);
    } else {
      paragraph = { type: 'paragraph', content: [node] };
      content.push(paragraph);
    }
  }
  return { type: 'doc', content };
}
