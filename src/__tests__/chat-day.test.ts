import { renderDay, dayKey, dayTitle, mergeMessages, DOC_TYPE } from '../chat-day';
import type { NormalizedMessage } from '../types';

const msg = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'm1',
  tsMs: Date.parse('2026-06-11T09:41:00Z'),
  sender: 'Alice',
  text: 'morning!',
  system: false,
  ...over,
});

describe('chat-day', () => {
  it('uses the v2 dotted document type', () => {
    expect(DOC_TYPE).toBe('whatsapp.chat_day');
  });

  it('buckets a timestamp into a YYYY-MM-DD local day key', () => {
    // Asserted against the runner's local tz via a fixed offset-free midpoint.
    expect(dayKey(Date.parse('2026-06-11T12:00:00'))).toBe('2026-06-11');
  });

  it('titles a day as "<chatName> — Mon D, YYYY"', () => {
    expect(dayTitle('Family', '2026-06-11')).toBe('Family — Jun 11, 2026');
  });

  it('merges by id, keeping one copy and sorting by ts', () => {
    const a = msg({ id: 'm1', tsMs: 2 });
    const b = msg({ id: 'm2', tsMs: 1, sender: 'Bob', text: 'hi' });
    const merged = mergeMessages([a], [b, { ...a }]);
    expect(merged.map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('lets incoming win on id conflict (live edit of a buffered message)', () => {
    const stale = msg({ id: 'm1', text: 'old' });
    const fresh = msg({ id: 'm1', text: 'new' });
    expect(mergeMessages([stale], [fresh])[0].text).toBe('new');
  });

  it('renders text, replies, media and system lines', () => {
    const md = renderDay([
      msg({ id: 'm1', text: 'morning!' }),
      msg({
        id: 'm2',
        sender: 'Bob',
        text: 'on my way',
        quote: { sender: 'Alice', snippet: 'morning!' },
      }),
      msg({ id: 'm3', sender: 'Bob', text: '', media: { kind: 'image' } }),
      msg({
        id: 'm4',
        sender: null,
        system: true,
        text: 'Messages are end-to-end encrypted.',
      }),
    ]);
    expect(md).toContain('Alice: morning!');
    expect(md).toContain('↳re Alice: morning!');
    expect(md).toContain('[image]');
    expect(md).toContain('_Messages are end-to-end encrypted._');
    // v2: sources never see DB ids, so no doc:// attachment links (the file
    // document's parent edge is the navigation instead).
    expect(md).not.toContain('doc://');
  });

  it('labels voice notes with their duration and documents with their filename', () => {
    const md = renderDay([
      msg({ id: 'm1', text: '', media: { kind: 'audio', durationSec: 65 } }),
      msg({
        id: 'm2',
        text: '',
        media: { kind: 'document', filename: 'invoice.pdf' },
      }),
    ]);
    expect(md).toContain('[voice note 1:05]');
    expect(md).toContain('[document: invoice.pdf]');
  });
});
