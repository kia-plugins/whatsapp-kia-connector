import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';

import type { MediaKind } from './types';

export const FILE_DOC_TYPE = 'file';

/** Download cap; larger media stays a placeholder (no bytes fetched). */
export const MEDIA_SIZE_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Production media fetch: decrypt one message's media to a buffer. Errors
 * resolve to null — the day doc keeps its `[image]`/`[document: …]` label and
 * the walk continues (one broken download must not abort anything). The
 * runtime calls this ONE message at a time: concurrent media fetches read as
 * abnormal-client behavior to WhatsApp and raise ban risk. The signal wires
 * abort straight into the CDN request (media downloads run over HTTPS,
 * independent of the socket) so a stop can't leave the fetch wedged.
 */
export async function defaultDownloadMedia(
  wm: proto.IWebMessageInfo,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const buf = await downloadMediaMessage(
      wm,
      'buffer',
      signal ? { options: { signal } } : {},
    );
    return Buffer.isBuffer(buf) ? buf : null;
  } catch {
    return null;
  }
}

/** 'audio/ogg; codecs=opus' → 'audio/ogg'. Empty/undefined stay undefined. */
export function normalizeMime(mimeType?: string): string | undefined {
  const base = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  return base.length > 0 ? base : undefined;
}

/** WhatsApp's usual media mimes → filename extension. Curated, not generic:
 *  a subtype like 'octet-stream' must never become an "extension". */
const MIME_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

export function extFromMime(mimeType?: string): string | undefined {
  const mime = normalizeMime(mimeType);
  return mime ? MIME_EXT[mime] : undefined;
}

const KIND_STEM: Record<MediaKind, string> = {
  audio: 'voice-note',
  image: 'photo',
  video: 'video',
  sticker: 'sticker',
  document: 'attachment',
};

/**
 * The file doc's filename: the real one when WhatsApp provides it (document
 * messages), else a kind-stemmed synthetic one ('voice-note.ogg',
 * 'photo.jpg'). Voice notes and photos carry NO filename on the wire, and the
 * platform's extraction classifiers fall back to filename/extension when a
 * doc has no mime — a filename-less doc would silently never be transcribed
 * or OCRed. Undefined when there's neither a name nor a known extension.
 */
export function attachmentFilename(
  kind: MediaKind,
  filename: string | undefined,
  mimeType: string | undefined,
): string | undefined {
  if (filename) return filename;
  const ext = extFromMime(mimeType);
  return ext ? `${KIND_STEM[kind]}.${ext}` : undefined;
}

/**
 * The wa_msg ref: one message proto-encoded to base64. Persisted in the file
 * doc's metadata so fetchBytes can rebuild the exact message — mediaKey,
 * directPath, url — and re-download/decrypt its media long after this run.
 * A plain string survives the store's JSON metadata and the extension-host
 * IPC boundary untouched. '' on encode failure (the doc simply loses its
 * deep-extraction path, never the emit).
 */
export function encodeMediaRef(wm: proto.IWebMessageInfo): string {
  try {
    const msg = proto.WebMessageInfo.fromObject(
      wm as unknown as Record<string, unknown>,
    );
    return Buffer.from(proto.WebMessageInfo.encode(msg).finish()).toString(
      'base64',
    );
  } catch {
    return '';
  }
}

/** Decode a wa_msg ref; null for anything unreadable or message-less (an
 *  empty/garbage ref must not reach downloadMediaMessage). */
export function decodeMediaRef(ref: string): proto.WebMessageInfo | null {
  try {
    const wm = proto.WebMessageInfo.decode(Buffer.from(ref, 'base64'));
    return wm.message ? wm : null;
  } catch {
    return null;
  }
}
