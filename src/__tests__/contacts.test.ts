import { ContactBook, normalizeJid } from '../contacts';

describe('normalizeJid', () => {
  it('strips the :device suffix down to the bare phone-user form', () => {
    expect(normalizeJid('4917012345:13@s.whatsapp.net')).toBe(
      '4917012345@s.whatsapp.net',
    );
  });

  it('leaves an already-bare JID untouched', () => {
    expect(normalizeJid('4917012345@s.whatsapp.net')).toBe(
      '4917012345@s.whatsapp.net',
    );
  });

  it('defaults the host when missing', () => {
    expect(normalizeJid('4917012345:2')).toBe('4917012345@s.whatsapp.net');
  });
});

describe('ContactBook', () => {
  it('resolves a known JID to its display name', () => {
    const book = new ContactBook('11111@s.whatsapp.net');
    book.set('22222@s.whatsapp.net', 'Alice');
    expect(book.name('22222@s.whatsapp.net')).toBe('Alice');
  });

  it('labels our own JID as "You"', () => {
    const book = new ContactBook('11111@s.whatsapp.net');
    expect(book.name('11111@s.whatsapp.net')).toBe('You');
  });

  it('falls back to the phone number for unknown JIDs', () => {
    const book = new ContactBook('11111@s.whatsapp.net');
    expect(book.name('49170123@s.whatsapp.net')).toBe('+49170123');
  });
});
