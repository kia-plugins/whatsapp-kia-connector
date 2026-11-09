import { ContactBook } from '../contacts';
import { normalizeWAMessage } from '../messages';

const book = new ContactBook('me@s.whatsapp.net');
book.set('alice@s.whatsapp.net', 'Alice');

describe('normalizeWAMessage', () => {
  it('normalizes a plain text message', () => {
    const n = normalizeWAMessage(
      {
        key: {
          id: 'M1',
          remoteJid: 'c@g.us',
          participant: 'alice@s.whatsapp.net',
        },
        messageTimestamp: 1749634895,
        message: { conversation: 'hello there' },
      } as any,
      book,
      'c@g.us',
    );
    expect(n).toMatchObject({
      id: 'M1',
      sender: 'Alice',
      text: 'hello there',
      system: false,
    });
    expect(n!.tsMs).toBe(1749634895000);
  });

  it('describes an image message with a caption', () => {
    const n = normalizeWAMessage(
      {
        key: {
          id: 'M2',
          remoteJid: 'c@g.us',
          participant: 'alice@s.whatsapp.net',
        },
        messageTimestamp: 1749634900,
        message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } },
      } as any,
      book,
      'c@g.us',
    );
    expect(n!.media).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' });
    expect(n!.text).toBe('look');
  });

  it('returns null for a key without a message body (e.g. reactions)', () => {
    const n = normalizeWAMessage(
      {
        key: { id: 'M3', remoteJid: 'c@g.us' },
        messageTimestamp: 1,
        message: { reactionMessage: {} },
      } as any,
      book,
      'c@g.us',
    );
    expect(n).toBeNull();
  });

  describe('wrapped messages (disappearing / view-once / caption docs)', () => {
    const dm = 'alice@s.whatsapp.net';
    const wrap = (message: unknown) =>
      normalizeWAMessage(
        {
          key: { id: 'W1', remoteJid: dm, fromMe: false },
          messageTimestamp: 1793900000,
          message,
        } as any,
        book,
        dm,
      );
    const voice = {
      audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 42, ptt: true },
    };

    it.each([
      ['ephemeralMessage', { ephemeralMessage: { message: voice } }],
      ['viewOnceMessage', { viewOnceMessage: { message: voice } }],
      ['viewOnceMessageV2', { viewOnceMessageV2: { message: voice } }],
      ['viewOnceMessageV2Extension', { viewOnceMessageV2Extension: { message: voice } }],
    ])('indexes a voice note wrapped in %s', (_name, message) => {
      expect(wrap(message)).toMatchObject({
        id: 'W1',
        sender: 'Alice',
        media: { kind: 'audio', durationSec: 42 },
      });
    });

    it('indexes text in a disappearing-messages chat, keeping its quote', () => {
      const n = wrap({
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: 'see you then',
              contextInfo: {
                participant: dm,
                quotedMessage: { conversation: 'tomorrow at 10?' },
              },
            },
          },
        },
      });
      expect(n).toMatchObject({ text: 'see you then', quote: { snippet: 'tomorrow at 10?' } });
    });

    it('indexes a document-with-caption nested inside an ephemeral wrapper', () => {
      const n = wrap({
        ephemeralMessage: {
          message: {
            documentWithCaptionMessage: {
              message: {
                documentMessage: { fileName: 'contract.pdf', caption: 'signed', mimetype: 'application/pdf' },
              },
            },
          },
        },
      });
      expect(n).toMatchObject({ text: 'signed', media: { kind: 'document', filename: 'contract.pdf' } });
    });

    it('still returns null for a wrapped reaction', () => {
      expect(wrap({ ephemeralMessage: { message: { reactionMessage: {} } } })).toBeNull();
    });
  });
});
