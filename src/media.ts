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
 * abnormal-client behavior to WhatsApp and raise ban risk.
 */
export async function defaultDownloadMedia(
  wm: proto.IWebMessageInfo,
): Promise<Buffer | null> {
  try {
    const buf = await downloadMediaMessage(wm, 'buffer', {});
    return Buffer.isBuffer(buf) ? buf : null;
  } catch {
    return null;
  }
}
