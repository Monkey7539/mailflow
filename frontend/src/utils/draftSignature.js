// Separate a saved draft's signature from its body when reopening it for editing.
//
// Drafts are stored on IMAP as one HTML document: body, then the signature block, then any
// quoted text. The compose window keeps the signature in its own editable region, so handing it
// the whole document as "body" meant the signature was in the body AND a fresh one was rendered
// below it. Saving again wrote both, so every open/save cycle added another copy (#432).
//
// buildRawDraft marks the block it writes with data-mailflow-signature, so it can be lifted back
// out exactly. Anything we cannot parse with certainty is left in the body and reported as
// "signature already inline", which tells the caller to render no separate signature region:
// still correct, still non-duplicating, just not separately editable. A mangled draft would be
// far worse than a signature the user has to edit in place, so ambiguity always loses.

const MARKER = 'data-mailflow-signature';

/** Index just past the </div> matching the <div> that starts at `open`, or -1 if unbalanced. */
function endOfDiv(html, open) {
  const tag = /<\s*(\/?)div\b[^>]*>/gi;
  tag.lastIndex = open;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * @returns {{ body: string, signature: string|null, inline: boolean }}
 *   signature — the lifted signature HTML, or null when there is nothing to lift
 *   inline    — true when a signature is present in the body but could not be lifted, so the
 *               caller must not render a second one
 */
export function splitDraftSignature(html) {
  const source = typeof html === 'string' ? html : '';
  if (!source) return { body: '', signature: null, inline: false };

  // Exactly one marked block, or we do not trust ourselves to pick the right one.
  const marks = [...source.matchAll(new RegExp(`<\\s*div\\b[^>]*${MARKER}`, 'gi'))];
  if (marks.length !== 1) {
    // A legacy draft (saved before the marker existed) still carries a signature in the body.
    // It cannot be lifted safely, so say so rather than adding a second one on top.
    return { body: source, signature: null, inline: looksLikeLegacySignature(source) || marks.length > 1 };
  }

  const start = marks[0].index;
  const end = endOfDiv(source, start);
  if (end === -1) return { body: source, signature: null, inline: true };

  const openTagEnd = source.indexOf('>', start) + 1;
  const closeTagStart = source.lastIndexOf('<', end - 1);
  const signature = source.slice(openTagEnd, closeTagStart);
  // Whatever followed the signature (quoted text) stays with the body, exactly where it was.
  return { body: source.slice(0, start) + source.slice(end), signature, inline: false };
}

/** The wrapper buildRawDraft emitted before the marker existed. */
function looksLikeLegacySignature(html) {
  return /<\s*div[^>]*margin-top:\s*16px;\s*color:\s*#555;\s*font-size:\s*13px/i.test(html);
}
