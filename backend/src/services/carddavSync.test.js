import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: () => 'app-password' }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: false }) }));
vi.mock('./carddavClient.js', () => ({ discoverAddressBooks: vi.fn(), fetchAddressBookCards: vi.fn() }));

import { query } from './db.js';
import { discoverAddressBooks, fetchAddressBookCards } from './carddavClient.js';
import { generateVCard, parseVCard } from '../utils/vcard.js';
import { syncUser } from './carddavSync.js';

// Alice as the user entered her in their Personal book.
const alice = {
  uid: 'local-uid', displayName: 'Alice', firstName: 'Alice', lastName: 'Smith',
  emails: [{ value: 'alice@example.com', type: 'other', primary: true }],
  phones: [{ value: '+1 555 0100', type: 'cell' }],
  organization: 'Acme', notes: 'met at conf 2025',
};

// Postgres hands JSONB objects back with their keys in its own order, not as written.
const pgPhones = phones => phones.map(({ value, type }) => ({ type, value }));

function personalRow(vcard = generateVCard(alice)) {
  return {
    address_book_id: 'personal-book', uid: alice.uid, vcard, etag: 'e1',
    display_name: alice.displayName, first_name: alice.firstName, last_name: alice.lastName,
    emails: alice.emails, phones: pgPhones(alice.phones),
    organization: alice.organization, notes: alice.notes, photo_data: null,
  };
}

// The same Alice as a phone stored her through MailFlow's CardDAV server, with
// properties MailFlow does not model.
const phoneCard = [
  'BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Apple Inc.//iOS 18.0//EN', 'UID:local-uid',
  'N:Smith;Alice;;;', 'FN:Alice', 'ORG:Acme', 'EMAIL;TYPE=HOME:alice@example.com',
  'TEL;TYPE=CELL:+1 555 0100', 'NOTE:met at conf 2025', 'BDAY:1990-04-01',
  'ADR;TYPE=HOME:;;1 Main St;Springfield;;12345;USA', 'END:VCARD', '',
].join('\r\n');

// Alice's card on the remote server, which merge mode matches to her by email.
const remoteCard = (...lines) =>
  ['BEGIN:VCARD', 'VERSION:3.0', 'UID:nc-alice', ...lines, 'EMAIL:alice@example.com', 'END:VCARD', ''].join('\r\n');

const photoLine = 'PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgo=';
const photoUri = 'data:image/png;base64,iVBORw0KGgo=';

// The remote server's address books, each mirrored into a read-only local book.
const contactsBook = { url: 'https://dav.example.com/alice/contacts/', displayName: 'Contacts' };
const teamBook = { url: 'https://dav.example.com/alice/team/', displayName: 'Team' };
const mirrorOf = { [contactsBook.url]: 'remote-book', [teamBook.url]: 'team-book' };

let row;
let updateRowCount;

beforeEach(() => {
  row = personalRow();
  updateRowCount = 1;
  discoverAddressBooks.mockResolvedValue([contactsBook]);
  query.mockReset();
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM user_integrations')) {
      return { rows: [{ config: { serverUrl: 'https://dav.example.com', username: 'alice', password: 'x', dupMode: 'merge' } }] };
    }
    if (sql.includes('external_url = $2')) return { rows: [{ id: mirrorOf[params[1]] }] };
    if (sql.includes('SELECT id, primary_email FROM contacts')) {
      return { rows: [{ id: 'personal-alice', primary_email: 'alice@example.com' }] };
    }
    if (/FROM contacts\s+WHERE id = \$1/.test(sql)) return { rows: [row] };
    if (/^\s*UPDATE contacts/.test(sql)) {
      if (!row || !updateRowCount) return { rows: [], rowCount: 0 };
      const [, display_name, first_name, last_name, phones, organization, notes, photo, vcard, etag] = params;
      row = {
        ...row, display_name, first_name, last_name, phones: pgPhones(JSON.parse(phones)),
        organization, notes, photo_data: photo ?? row.photo_data, vcard, etag,
      };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
});

async function syncCard(vcard) {
  fetchAddressBookCards.mockResolvedValue([{ href: '/alice/contacts/alice.vcf', vcard }]);
  expect(await syncUser('u1')).toMatchObject({ ok: true });
}

const contactWrites = () => query.mock.calls.filter(([sql]) => /^\s*UPDATE contacts/.test(sql));
const bumpedBooks = () => query.mock.calls
  .filter(([sql]) => sql.includes('UPDATE address_books SET sync_token'))
  .map(([, params]) => params[0]);

// The SQL, columns and stored vCard of the one write to the Personal contact.
function written() {
  const writes = contactWrites();
  expect(writes).toHaveLength(1);
  const [sql, [id, display_name, first_name, last_name, phones, organization, notes, photo, vcard, etag]] = writes[0];
  expect(id).toBe('personal-alice');
  return {
    sql, display_name, first_name, last_name, phones: JSON.parse(phones), organization, notes, photo,
    vcard, etag, card: parseVCard(vcard),
  };
}

describe('syncUser in merge mode', () => {
  it("keeps the contact's own details that the card does not carry", async () => {
    row.photo_data = 'data:image/jpeg;base64,/9j/4AAQ';
    await syncCard(remoteCard('FN:Alice Smith'));

    const w = written();
    expect(w).toMatchObject({
      display_name: 'Alice Smith', first_name: 'Alice', last_name: 'Smith',
      phones: [{ value: '+1 555 0100', type: 'cell' }], organization: 'Acme', notes: 'met at conf 2025',
    });
    expect(w.photo).toBeNull();
    expect(w.sql).toContain('photo_data = COALESCE($8, photo_data)');
    expect(w.card).toMatchObject({
      uid: 'local-uid', displayName: 'Alice Smith', lastName: 'Smith',
      phones: [{ value: '+1 555 0100', type: 'cell' }], organization: 'Acme', notes: 'met at conf 2025',
    });
    expect(w.etag).toBe(crypto.createHash('md5').update(w.vcard).digest('hex'));
  });

  it("lets the card win where it has a value and adds its numbers after the contact's own", async () => {
    await syncCard(remoteCard(
      'FN:Alice Jones', 'N:Jones;Alice;;;', 'TEL;TYPE=WORK:+1 555 0199', 'TEL;TYPE=HOME:+1 555 0100',
      'ORG:NewCo', 'NOTE:from Nextcloud',
    ));

    expect(written()).toMatchObject({
      display_name: 'Alice Jones', first_name: 'Alice', last_name: 'Jones',
      phones: [{ value: '+1 555 0100', type: 'home' }, { value: '+1 555 0199', type: 'work' }],
      organization: 'NewCo', notes: 'from Nextcloud',
    });
  });

  it.each([
    ['has no FN', remoteCard('NOTE:from Nextcloud')],
    ['has the email address as its FN', remoteCard('FN:Alice@Example.com', 'NOTE:from Nextcloud')],
  ])('does not rename the contact to its email when the card %s', async (_, vcard) => {
    await syncCard(vcard);

    const w = written();
    expect(w.display_name).toBe('Alice');
    expect(w.card.displayName).toBe('Alice');
  });

  it("bumps the merged contact's book so CardDAV clients fetch the change", async () => {
    await syncCard(remoteCard('FN:Alice Smith'));

    expect(bumpedBooks().sort()).toEqual(['personal-book', 'remote-book']);
  });

  it.each([
    ['as MailFlow generated it', generateVCard(alice)],
    ['as a phone stored it', phoneCard],
    ['as a phone stored it under a UID other than its file name', phoneCard.replace('UID:local-uid', 'UID:5F2C9E1A:ABPerson')],
  ])('writes nothing when the merge changes nothing (card %s)', async (_, vcard) => {
    row = personalRow(vcard);
    await syncCard(remoteCard('FN:Alice', 'TEL;TYPE=CELL:+1 555 0100'));

    expect(contactWrites()).toEqual([]);
    expect(bumpedBooks()).toEqual(['remote-book']);
  });

  it('writes nothing when the card lists the same numbers in another order', async () => {
    const phones = [{ value: '+1 555 0100', type: 'cell' }, { value: '+1 555 0199', type: 'work' }];
    row = { ...personalRow(generateVCard({ ...alice, phones })), phones: pgPhones(phones) };
    await syncCard(remoteCard('FN:Alice', 'TEL;TYPE=WORK:+1 555 0199', 'TEL;TYPE=CELL:+1 555 0100'));

    expect(contactWrites()).toEqual([]);
  });

  it.each([
    ['the remote card, as an earlier merge stored it', remoteCard('FN:Alice', 'N:Smith;Alice;;;', 'TEL;TYPE=CELL:+1 555 0100', 'ORG:Acme', 'NOTE:met at conf 2025')],
    // Contacts carried over by the contacts_v2 migration have no stored card.
    ['missing', null],
  ])("stores the contact's own card when its stored card is %s", async (_, vcard) => {
    row = personalRow(vcard);
    await syncCard(remoteCard('FN:Alice', 'N:Smith;Alice;;;', 'TEL;TYPE=CELL:+1 555 0100', 'ORG:Acme', 'NOTE:met at conf 2025'));

    expect(written().card).toMatchObject({ uid: 'local-uid', displayName: 'Alice', notes: 'met at conf 2025' });
  });

  it('leaves a contact edited during the sync for the next sync', async () => {
    updateRowCount = 0;
    await syncCard(remoteCard('FN:Alice Smith'));

    const [[sql, params]] = contactWrites();
    expect(sql).toMatch(/WHERE id = \$1 AND etag = \$\d+/);
    expect(params[Number(sql.match(/AND etag = \$(\d+)/)[1]) - 1]).toBe('e1');
    expect(bumpedBooks()).toEqual(['remote-book']);
  });

  it('skips a contact deleted after the sync listed it', async () => {
    row = undefined;
    await syncCard(remoteCard('FN:Alice Smith'));

    expect(contactWrites()).toEqual([]);
    expect(bumpedBooks()).toEqual(['remote-book']);
  });

  it("takes the card's photo when that is all it adds, once", async () => {
    const card = remoteCard('FN:Alice', 'TEL;TYPE=CELL:+1 555 0100', photoLine);
    await syncCard(card);

    expect(written().photo).toBe(photoUri);
    expect(bumpedBooks().sort()).toEqual(['personal-book', 'remote-book']);

    query.mockClear();
    await syncCard(card);
    expect(contactWrites()).toEqual([]);
  });

  it('settles when two remote books have a card for the same email', async () => {
    discoverAddressBooks.mockResolvedValue([contactsBook, teamBook]);
    const cards = {
      [contactsBook.url]: remoteCard('FN:Alice A', 'TEL;TYPE=WORK:+1 555 0199', photoLine),
      [teamBook.url]: remoteCard(
        'FN:Alice B', 'TEL;TYPE=CELL:+1 555 0199', 'TEL;TYPE=HOME:+1 555 0142', 'PHOTO;ENCODING=b;TYPE=GIF:R0lGODlh',
      ).replace('UID:nc-alice', 'UID:team-alice'),
    };
    fetchAddressBookCards.mockImplementation(async ({ url }) => [{ href: `${url}alice.vcf`, vcard: cards[url] }]);

    expect(await syncUser('u1')).toMatchObject({ ok: true });
    // The first book wins where both have a value; the second only fills gaps.
    expect(row).toMatchObject({
      display_name: 'Alice A', photo_data: photoUri,
      phones: [
        { type: 'cell', value: '+1 555 0100' }, { type: 'work', value: '+1 555 0199' },
        { type: 'home', value: '+1 555 0142' },
      ],
    });

    query.mockClear();
    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(contactWrites()).toEqual([]);
    expect(bumpedBooks().sort()).toEqual(['remote-book', 'team-book']);
  });
});
