/**
 * source.fetchBytes — the deep-extraction byte path. kiagent-core's vision
 * (OCR/VLM) and audio (transcription) workers call it to re-fetch a file
 * doc's bytes on demand; the store never keeps binary, so the wa_msg proto
 * ref persisted in the doc's metadata is the only way back to the CDN.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { proto } from '@whiskeysockets/baileys';

import type {
  Account,
  Document,
  HostFor,
  Session,
} from '../kiagent-contracts';
import { encodeMediaRef, MEDIA_SIZE_CAP_BYTES } from '../media';
import { createWhatsAppSource } from '../source';

function makeHost(): HostFor<'net' | 'query'> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fetch-'));
  return {
    self: { id: 'kia.whatsapp', dataDir: dir },
    log: () => {},
    net: { fetch: async () => ({}) },
    query: { byExternalId: async () => null } as never,
  };
}

const session: Session = {
  account: {
    id: 'acc-1',
    source: 'whatsapp',
    identifier: 'x',
    config: {},
    status: 'live',
    cursor: null,
    createdAt: '',
  } as Account,
  signal: new AbortController().signal,
  credentials: async () => null,
  log: () => {},
};

const wm = {
  key: { id: 'A1', remoteJid: 'alice@s.whatsapp.net' },
  message: {
    audioMessage: {
      mimetype: 'audio/ogg; codecs=opus',
      directPath: '/v/t62/xyz',
      mediaKey: new Uint8Array([9, 9, 9]),
    },
  },
};

function fileDoc(metadata: Record<string, unknown>): Document {
  return {
    id: 'doc-1',
    accountId: 'acc-1',
    externalId: 'alice@s.whatsapp.net:A1',
    type: 'file',
    title: 'voice-note.ogg',
    markdown: null,
    parentId: null,
    contentHash: '',
    seq: 1,
    archivedAt: null,
    languages: [],
    ingestedAt: '',
    updatedAt: '',
    createdAt: null,
    metadata,
  } as Document;
}

describe('fetchBytes', () => {
  it('decodes wa_msg and returns the downloaded bytes', async () => {
    const seen: unknown[] = [];
    const source = createWhatsAppSource(makeHost(), {
      downloadMedia: (async (m: unknown) => {
        seen.push(m);
        return Buffer.from('audio-bytes');
      }) as never,
    });
    const bytes = await source.fetchBytes!(
      session,
      fileDoc({ wa_msg: encodeMediaRef(wm as never) }),
    );
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString()).toBe('audio-bytes');
    // The reconstructed message carries the decryption material.
    const audio = (seen[0] as proto.IWebMessageInfo).message!.audioMessage!;
    expect(Array.from(audio.mediaKey as Uint8Array)).toEqual([9, 9, 9]);
    expect(audio.directPath).toBe('/v/t62/xyz');
  });

  it('returns null (and never downloads) without a usable wa_msg ref', async () => {
    let called = 0;
    const source = createWhatsAppSource(makeHost(), {
      downloadMedia: (async () => {
        called += 1;
        return Buffer.from('x');
      }) as never,
    });
    expect(await source.fetchBytes!(session, fileDoc({}))).toBeNull();
    expect(await source.fetchBytes!(session, fileDoc({ wa_msg: 42 }))).toBeNull();
    expect(
      await source.fetchBytes!(session, fileDoc({ wa_msg: 'garbage!!!' })),
    ).toBeNull();
    expect(called).toBe(0);
  });

  it('returns null when the download fails or the bytes overstep the size cap', async () => {
    const ref = encodeMediaRef(wm as never);
    const failing = createWhatsAppSource(makeHost(), {
      downloadMedia: (async () => null) as never,
    });
    expect(await failing.fetchBytes!(session, fileDoc({ wa_msg: ref }))).toBeNull();

    const oversized = createWhatsAppSource(makeHost(), {
      downloadMedia: (async () =>
        Buffer.alloc(MEDIA_SIZE_CAP_BYTES + 1)) as never,
    });
    expect(await oversized.fetchBytes!(session, fileDoc({ wa_msg: ref }))).toBeNull();
  });
});
