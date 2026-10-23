import { describe, expect, it } from 'vitest';
import { detectAttachments } from './messageParser.js';

describe('detectAttachments', () => {
  it('flags an explicit attachment disposition anywhere in the tree', () => {
    expect(detectAttachments({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain' },
        { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } },
      ],
    })).toBe(true);
  });

  it('flags a named inline text part alongside an unnamed body part', () => {
    expect(detectAttachments({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/html' },
        { type: 'text/html', disposition: 'inline', dispositionParameters: { filename: 'report.html' } },
      ],
    })).toBe(true);
    expect(detectAttachments({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain' },
        { type: 'text/plain', parameters: { name: 'server.log' } },
      ],
    })).toBe(true);
  });

  // imapflow gives a message/rfc822 part the embedded message's structure as its children.
  const embeddedMessage = { type: 'multipart/alternative', childNodes: [{ type: 'text/plain' }, { type: 'text/html' }] };

  it('flags a message/rfc822 part with a filename, however it is disposed', () => {
    const withAttachedMessage = (wrapper) => ({
      type: 'multipart/mixed',
      childNodes: [{ type: 'text/plain' }, { type: 'message/rfc822', ...wrapper, childNodes: [embeddedMessage] }],
    });
    // nodemailer marks message/* inline unless told otherwise.
    expect(detectAttachments(withAttachedMessage({
      disposition: 'inline',
      dispositionParameters: { filename: 'Original.eml' },
      parameters: { name: 'Original.eml' },
    }))).toBe(true);
    expect(detectAttachments(withAttachedMessage({
      disposition: 'inline', dispositionParameters: { filename: 'Original.eml' },
    }))).toBe(true);
    expect(detectAttachments(withAttachedMessage({ parameters: { name: 'Original.eml' } }))).toBe(true);
    // Without the embedded structure, walkStructure still lists the part by its name.
    expect(detectAttachments({
      type: 'multipart/mixed',
      childNodes: [{ type: 'text/plain' }, { type: 'message/rfc822', parameters: { name: 'Original.eml' } }],
    })).toBe(true);
  });

  it('does not flag an embedded message with no filename, as a bounce report has', () => {
    const bounce = (wrapper) => ({
      type: 'multipart/report',
      childNodes: [
        { type: 'text/plain' },
        { type: 'message/delivery-status' },
        { type: 'message/rfc822', ...wrapper, childNodes: [embeddedMessage] },
      ],
    });
    expect(detectAttachments(bounce({}))).toBe(false);
    expect(detectAttachments(bounce({ disposition: 'inline' }))).toBe(false);
  });

  it('does not flag an ordinary multipart/alternative body', () => {
    expect(detectAttachments({
      type: 'multipart/alternative',
      childNodes: [{ type: 'text/plain' }, { type: 'text/html' }],
    })).toBe(false);
  });

  it('does not flag a message whose only text parts are named', () => {
    expect(detectAttachments({
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', parameters: { name: 'body.txt' } },
        { type: 'text/html', parameters: { name: 'body.html' } },
      ],
    })).toBe(false);
  });

  it('is false for missing structure', () => {
    expect(detectAttachments(null)).toBe(false);
  });
});
