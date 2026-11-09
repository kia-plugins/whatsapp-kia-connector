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

describe('ContactBook — aliases, fallback guard, persistence', () => {
  const PN = '4917612345678@s.whatsapp.net';
  const LID = '84666791022771@lid';

  it('resolves a name known under either id of an aliased pair', () => {
    const b = new ContactBook('me@s.whatsapp.net');
    b.set(PN, 'Theresa');
    expect(b.name(LID)).toBe('+84666791022771');
    b.alias(LID, PN);
    expect(b.known(LID)).toBe('Theresa');
    expect(b.name(`${PN.split('@')[0]}:3@s.whatsapp.net`)).toBe('Theresa');
  });

  it('never lets a number replace a real name', () => {
    const b = new ContactBook('me@s.whatsapp.net');
    b.set(LID, 'Theresa');
    b.set(LID, '+84666791022771');
    b.set(LID, '84666791022771');
    expect(b.known(LID)).toBe('Theresa');
  });

  it('reports learned names (both ids) and survives snapshot/restore', () => {
    const b = new ContactBook('me@s.whatsapp.net');
    const learned: string[][] = [];
    b.onLearn = (j) => learned.push(j);
    b.alias(LID, PN);
    b.set(PN, 'Theresa');
    expect(learned).toEqual([[PN, LID]]);
    const c = new ContactBook('me@s.whatsapp.net');
    c.restore(JSON.parse(JSON.stringify(b.snapshot())));
    expect(c.known(LID)).toBe('Theresa');
    c.restore({ names: { x: 42, y: '+1' }, aliases: [['a']] }); // junk is skipped
    expect(c.known('y')).toBeNull();
  });
});
