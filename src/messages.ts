import type { proto } from '@whiskeysockets/baileys';

import type { ContactBook } from './contacts';
import type { MediaDescriptor, NormalizedMessage } from './types';

/** Which Baileys media sub-message (if any) this carries, → descriptor + caption. */
function mediaOf(
  m: proto.IMessage,
): { media: MediaDescriptor; caption: string } | null {
  if (m.imageMessage)
    return {
      media: { kind: 'image', mimeType: m.imageMessage.mimetype ?? undefined },
      caption: m.imageMessage.caption ?? '',
    };
  if (m.videoMessage)
    return {
      media: {
        kind: 'video',
        mimeType: m.videoMessage.mimetype ?? undefined,
        durationSec: m.videoMessage.seconds ?? undefined,
      },
      caption: m.videoMessage.caption ?? '',
    };
  if (m.audioMessage)
    return {
      media: {
        kind: 'audio',
        mimeType: m.audioMessage.mimetype ?? undefined,
        durationSec: m.audioMessage.seconds ?? undefined,
      },
      caption: '',
    };
  if (m.documentMessage)
    return {
      media: {
        kind: 'document',
        filename: m.documentMessage.fileName ?? undefined,
        mimeType: m.documentMessage.mimetype ?? undefined,
      },
      caption: m.documentMessage.caption ?? '',
    };
  if (m.stickerMessage)
    return {
      media: {
        kind: 'sticker',
        mimeType: m.stickerMessage.mimetype ?? undefined,
      },
      caption: '',
    };
  return null;
}

function plainText(m: proto.IMessage): string | null {
  if (typeof m.conversation === 'string') return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  return null;
}

/**
 * Peel Baileys' "future-proof" envelopes off a message. A chat with
 * disappearing messages wraps every message in `ephemeralMessage`; view-once
 * media comes in `viewOnceMessage*`; captioned documents in
 * `documentWithCaptionMessage` — and they nest (ephemeral → doc-with-caption).
 * `messages.upsert` delivers them still wrapped, so reading `audioMessage` etc.
 * off the top level silently drops them. Mirrors Baileys'
 * `normalizeMessageContent` (same wrappers, same depth bound) without pulling
 * Baileys' runtime into this pure module.
 */
export function unwrapMessage(
  m: proto.IMessage | null | undefined,
): proto.IMessage | undefined {
  let content = m ?? undefined;
  for (let i = 0; i < 5 && content; i++) {
    const inner =
      content.ephemeralMessage ??
      content.viewOnceMessage ??
      content.documentWithCaptionMessage ??
      content.viewOnceMessageV2 ??
      content.viewOnceMessageV2Extension ??
      content.editedMessage;
    if (!inner?.message) break;
    content = inner.message;
  }
  return content;
}

/** Robustly coerce a Baileys timestamp (number | Long | null) to epoch ms. */
function tsToMs(ts: proto.IWebMessageInfo['messageTimestamp']): number {
  if (ts == null) return 0;
  const seconds = typeof ts === 'number' ? ts : ts.toNumber();
  return seconds * 1000;
}

/** Map a Baileys message to NormalizedMessage; null = nothing to index. */
export function normalizeWAMessage(
  wm: proto.IWebMessageInfo,
  book: ContactBook,
  chatJid: string,
): NormalizedMessage | null {
  const id = wm.key?.id;
  const msg = unwrapMessage(wm.message);
  if (!id || !msg) return null;

  const tsMs = tsToMs(wm.messageTimestamp);
  const senderJid = chatJid.endsWith('@g.us')
    ? (wm.key?.participant ?? undefined)
    : wm.key?.fromMe
      ? undefined
      : chatJid; // dm: other party = chat jid
  const sender = wm.key?.fromMe ? 'You' : book.name(senderJid ?? null);

  const media = mediaOf(msg);
  const text = plainText(msg) ?? media?.caption ?? '';
  if (!media && !text) return null; // reactions, protocol msgs, etc.

  // Quoted message, if present on an extended text.
  const ctx = msg.extendedTextMessage?.contextInfo;
  const quote = ctx?.quotedMessage
    ? {
        sender: book.name(ctx.participant ?? null),
        snippet: (ctx.quotedMessage.conversation ?? '').slice(0, 80),
      }
    : undefined;

  return { id, tsMs, sender, text, media: media?.media, quote, system: false };
}
