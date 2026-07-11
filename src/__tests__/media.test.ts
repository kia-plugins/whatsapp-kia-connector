/**
 * Media helpers behind the deep-extraction handoff: mime normalization,
 * extension derivation, synthetic filenames for filename-less media (voice
 * notes, photos), and the wa_msg proto ref that lets fetchBytes re-download
 * a message's media long after the pull that first saw it.
 */
import {
  attachmentFilename,
  decodeMediaRef,
  encodeMediaRef,
  extFromMime,
  normalizeMime,
} from '../media';

describe('normalizeMime', () => {
  it('strips codec parameters (voice notes arrive as "audio/ogg; codecs=opus")', () => {
    expect(normalizeMime('audio/ogg; codecs=opus')).toBe('audio/ogg');
  });

  it('passes plain mimes through; empty/undefined stay undefined', () => {
    expect(normalizeMime('image/jpeg')).toBe('image/jpeg');
    expect(normalizeMime(undefined)).toBeUndefined();
    expect(normalizeMime('')).toBeUndefined();
  });
});

describe('extFromMime', () => {
  it.each([
    ['audio/ogg', 'ogg'],
    ['audio/ogg; codecs=opus', 'ogg'],
    ['audio/mpeg', 'mp3'],
    ['audio/mp4', 'm4a'],
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['video/mp4', 'mp4'],
    ['application/pdf', 'pdf'],
  ])('%s → %s', (mime, ext) => {
    expect(extFromMime(mime)).toBe(ext);
  });

  it('returns undefined for unknown mimes', () => {
    expect(extFromMime('application/x-mystery')).toBeUndefined();
  });
});

describe('attachmentFilename', () => {
  it('keeps a real filename untouched', () => {
    expect(attachmentFilename('document', 'report.pdf', 'application/pdf')).toBe(
      'report.pdf',
    );
  });

  it('synthesizes kind-specific names for filename-less media', () => {
    expect(attachmentFilename('audio', undefined, 'audio/ogg')).toBe(
      'voice-note.ogg',
    );
    expect(attachmentFilename('image', undefined, 'image/jpeg')).toBe(
      'photo.jpg',
    );
    expect(attachmentFilename('video', undefined, 'video/mp4')).toBe(
      'video.mp4',
    );
    expect(attachmentFilename('sticker', undefined, 'image/webp')).toBe(
      'sticker.webp',
    );
  });

  it('returns undefined without a filename or a known extension', () => {
    expect(attachmentFilename('audio', undefined, undefined)).toBeUndefined();
    expect(
      attachmentFilename('document', undefined, 'application/x-mystery'),
    ).toBeUndefined();
  });
});

describe('media ref (wa_msg)', () => {
  const wm = {
    key: { id: 'A1', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1750000000,
    message: {
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        seconds: 42,
        ptt: true,
        url: 'https://mmg.whatsapp.net/d/f/abc',
        directPath: '/v/t62.7117-24/xyz',
        mediaKey: new Uint8Array([1, 2, 3, 4]),
        fileEncSha256: new Uint8Array([5, 6]),
        fileSha256: new Uint8Array([7, 8]),
        fileLength: 12345,
      },
    },
  };

  it('round-trips the fields downloadMediaMessage needs (mediaKey, directPath, url, mimetype)', () => {
    const ref = encodeMediaRef(wm as never);
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);
    const back = decodeMediaRef(ref);
    expect(back).not.toBeNull();
    const audio = back!.message!.audioMessage!;
    expect(Array.from(audio.mediaKey as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(audio.directPath).toBe('/v/t62.7117-24/xyz');
    expect(audio.url).toBe('https://mmg.whatsapp.net/d/f/abc');
    expect(audio.mimetype).toBe('audio/ogg; codecs=opus');
    expect(back!.key!.id).toBe('A1');
  });

  it('decodeMediaRef returns null for refs that carry no message', () => {
    expect(decodeMediaRef('')).toBeNull();
    expect(decodeMediaRef('definitely-not-a-proto')).toBeNull();
  });
});
