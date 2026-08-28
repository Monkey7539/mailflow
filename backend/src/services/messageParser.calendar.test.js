import { describe, expect, it } from 'vitest';
import { renderCalendarInvite } from './messageParser.js';

// Trimmed real-world Outlook meeting forward: folded lines (tab continuation),
// quoted TZID with spaces, escaped commas/newlines, X-ALT-DESC HTML form.
const OUTLOOK_ICS = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE',
  'TZID:Eastern Standard Time',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ATTENDEE;CN="\'Marty A\'";RSVP=TRUE:mailto:marty@example.com',
  'DESCRIPTION: \\n\\n-----Original Appointment-----\\nFrom: Scott\\, Charles',
  '\tE. <charles@example.com>\\nWhere: Microsoft Teams Meeting\\n',
  'DTEND;TZID="Eastern Standard Time":20260901T143000',
  'DTSTART;TZID="Eastern Standard Time":20260901T140000',
  'LOCATION:Microsoft Teams Meeting',
  'ORGANIZER;CN="Scott, Charles E.":mailto:charles@example.com',
  'SUMMARY;LANGUAGE=en-us:FW: ARENA x BANK: Relationship Management Introduc',
  '\ttion (placeholder)',
  'X-ALT-DESC;FMTTYPE=text/html:<html><body><p>Join: <a href="https://teams.e',
  '\txample.com/meet/1">link</a></p></body></html>',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('renderCalendarInvite', () => {
  it('renders a summary card from a folded, escaped Outlook invite', () => {
    const invite = renderCalendarInvite(OUTLOOK_ICS);
    expect(invite).not.toBeNull();
    expect(invite.html).toContain('Meeting invitation');
    // Folded SUMMARY line reassembled across the tab continuation.
    expect(invite.html).toContain('FW: ARENA x BANK: Relationship Management Introduction (placeholder)');
    expect(invite.html).toContain('Tuesday, September 1, 2026, 2:00 PM – 2:30 PM (Eastern Standard Time)');
    expect(invite.html).toContain('Where:</b> Microsoft Teams Meeting');
    // Quoted CN param with a comma inside survives; mailto: prefix stripped.
    expect(invite.html).toContain('Scott, Charles E. &lt;charles@example.com&gt;');
  });

  it('prefers the X-ALT-DESC HTML form of the description', () => {
    const invite = renderCalendarInvite(OUTLOOK_ICS);
    expect(invite.html).toContain('href="https://teams.example.com/meet/1"');
    // The escaped plain DESCRIPTION is not doubled in when HTML exists.
    expect(invite.html).not.toContain('-----Original Appointment-----');
    // The text form keeps the plain description with unescaped newlines/commas.
    expect(invite.text).toContain('-----Original Appointment-----');
    expect(invite.text).toContain('From: Scott, Charles');
  });

  it('falls back to the escaped plain DESCRIPTION when no HTML form exists', () => {
    const ics = OUTLOOK_ICS.split('\r\n').filter(l => !/^(X-ALT-DESC|\t[xt])/.test(l))
      .filter(l => !l.startsWith('X-ALT-DESC') && !l.includes('xample.com/meet/1'))
      .join('\r\n');
    const invite = renderCalendarInvite(ics);
    expect(invite.html).toContain('-----Original Appointment-----');
    expect(invite.html).toContain('From: Scott, Charles');
    // Angle brackets in the description are escaped, not parsed as HTML.
    expect(invite.html).toContain('&lt;charles@example.com&gt;');
  });

  it('returns null for non-calendar and eventless input', () => {
    expect(renderCalendarInvite('hello world')).toBeNull();
    expect(renderCalendarInvite('')).toBeNull();
    expect(renderCalendarInvite('BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR')).toBeNull();
  });

  it('labels a cancellation and handles UTC and date-only times', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      'SUMMARY:Board sync',
      'DTSTART:20261005T183000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const invite = renderCalendarInvite(ics);
    expect(invite.html).toContain('Meeting cancelled');
    expect(invite.html).toContain('Monday, October 5, 2026, 6:30 PM UTC');
  });
});
