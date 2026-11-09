import { storedDayUnnamed } from '../names';

describe('storedDayUnnamed', () => {
  const msg = (sender: string, system = false) => ({ id: 'x', tsMs: 0, sender, text: '', system });

  it('flags a day whose chat name is a number', () => {
    expect(storedDayUnnamed({ chat_name: '+4917612345678', chat_type: 'dm', messages: [] })).toBe(true);
  });

  it('flags a DM whose other-party sender is a number, ignoring You and system lines', () => {
    expect(storedDayUnnamed({ chat_name: 'Theresa', chat_type: 'dm', messages: [msg('You'), msg('+4917612345678')] })).toBe(true);
    expect(storedDayUnnamed({ chat_name: 'Theresa', chat_type: 'dm', messages: [msg('You'), msg('', true), msg('Theresa')] })).toBe(false);
  });

  it('does not flag a named group for numeric participants (no participant ids are stored)', () => {
    expect(storedDayUnnamed({ chat_name: 'Kita', chat_type: 'group', messages: [msg('+4917612345678')] })).toBe(false);
  });
});
