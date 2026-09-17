// Attachment risk classification by file extension (the declared MIME type is
// sender-controlled and routinely wrong). Three levels:
//   block  — executables, scripts, installers, disk images, shortcuts: run code
//   warn   — macro-enabled Office, HTML/SVG (credential-harvesting pages)
//   notice — archives, whose contents nothing here can inspect
// A double extension ("invoice.pdf.exe") is classified by its real (last)
// extension and reports the hidden tail so the disguise is visible. The tiers
// themselves live in attachmentExtensions.js.

import { BLOCK, WARN, NOTICE, DECOY } from './attachmentExtensions.js';

// Word-processing formats a document is converted from when it goes out as RTF under its old name
// ("Letter.doc.rtf"). The hidden .rtf opens in the same kind of program the visible half promises, so
// that is not reported as a disguise; a PDF, picture or media name in front of .rtf still is.
const RTF_SOURCES = new Set(['doc', 'docx', 'odt']);

export function classifyAttachmentRisk(filename, mimeType = '') {
  const name = stripTrailingDotsAndSpaces(String(filename || '').trim()).toLowerCase();
  const parts = name.split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  const prevExt = parts.length > 2 ? parts[parts.length - 2] : '';
  // ".pdf.exe": an innocent-looking extension right before the real one
  const disguised = (BLOCK.has(ext) || WARN.has(ext)) && DECOY.has(prevExt)
    && !(ext === 'rtf' && RTF_SOURCES.has(prevExt));
  const doubleExt = disguised ? `${prevExt}.${ext}` : null;

  const mime = String(mimeType || '').toLowerCase();
  if (BLOCK.has(ext) || /x-msdownload|x-msdos-program|x-sh\b|x-shellscript|java-archive|x-iso9660|vnd\.microsoft\.portable-executable/.test(mime)) {
    return { level: 'block', ext, doubleExt };
  }
  if (WARN.has(ext) || /macroenabled|text\/html|image\/svg/.test(mime)) {
    return { level: 'warn', ext, doubleExt };
  }
  if (NOTICE.has(ext) || /zip|x-rar|x-7z|x-tar|gzip|x-bzip/.test(mime)) {
    return { level: 'notice', ext, doubleExt };
  }
  return { level: 'ok', ext, doubleExt: null };
}

// Windows, and browsers such as Firefox, drop trailing dots and spaces from a saved file name, so
// "invoice.exe." can land on disk as invoice.exe. U+180E is included because \s no longer matches it
// but download sanitizers may still strip it. A loop rather than /[.\s]+$/, which backtracks
// quadratically on a long run of dots or spaces in the middle of a name.
function stripTrailingDotsAndSpaces(name) {
  let end = name.length;
  while (end > 0 && /[.\s\u180E]/.test(name[end - 1])) end--;
  return name.slice(0, end);
}
