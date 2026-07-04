import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';

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
