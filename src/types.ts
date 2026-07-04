/** A single chat message after normalization from either ingest path. */
export interface NormalizedMessage {
  /** Stable id: the WhatsApp message id. */
  id: string;
  /** Epoch milliseconds. */
  tsMs: number;
  /** Display name of the sender, already resolved. null ⇒ system message. */
  sender: string | null;
  /** Plain text body (caption for media, '' for pure media/system). */
  text: string;
  /** Present when the message carries media. */
  media?: MediaDescriptor;
  /** Quoted/replied-to message, rendered inline. */
  quote?: { sender: string | null; snippet: string };
  /** True for WhatsApp system notices (e2e notice, "X added Y", etc.). */
  system: boolean;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface MediaDescriptor {
  kind: MediaKind;
  /** Original filename if known (document messages). */
  filename?: string;
  /** Mime type if known. */
  mimeType?: string;
  /** Duration seconds for audio/video, for the placeholder label. */
  durationSec?: number;
}

/** Resolved chat identity at flush time (name re-resolved on every build). */
export interface ChatInfo {
  jid: string;
  name: string;
  type: 'dm' | 'group';
}

/** Account.cursor shape. Vestigial but observable (WhatsApp pushes history —
 *  idempotency lives in the per-day ledger merge, not the cursor), committed
 *  transactionally with every batch. */
export interface WhatsAppCursor {
  /** Highest message timestamp (ms) ingested so far. */
  lastTsMs: number;
}

/** One (chat, local-day) document with its COMPLETE merged message ledger. */
export interface DayItem {
  kind: 'day';
  chat: ChatInfo;
  /** Local-calendar day key 'YYYY-MM-DD'. */
  day: string;
  /** Full merged ledger for the day, ascending (ts, id). */
  messages: NormalizedMessage[];
}

/** Downloaded media bytes for one message, parented under its day item. */
export interface FileItem {
  kind: 'file';
  chatJid: string;
  /** Local day key of the owning chat-day (the parent edge). */
  day: string;
  msgId: string;
  bytes: Uint8Array;
  mimeType?: string;
  filename?: string;
  /** Epoch-ms send time of the carrying message (drives createdAt). */
  sentAtMs: number;
}

export type WhatsAppItem = DayItem | FileItem;
