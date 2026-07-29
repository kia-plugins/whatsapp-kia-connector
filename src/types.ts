// NormalizedMessage/MediaKind/MediaDescriptor now live in the SDK's
// chat-day module (identical shape to what this repo used to define
// locally) — re-exported here so the rest of the repo keeps importing them
// from './types'.
import type {
  NormalizedMessage,
  MediaKind,
  MediaDescriptor,
} from '@kiagent/connector-sdk/chat-day';

export type { NormalizedMessage, MediaKind, MediaDescriptor };

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
  /** Which media sub-message carried the bytes — stems the synthetic
   *  filename for media WhatsApp ships nameless (voice notes, photos). */
  mediaKind: MediaKind;
  /** base64 proto.WebMessageInfo of the carrying message — persisted as
   *  metadata.wa_msg, fetchBytes' way back to the CDN bytes ('' if the
   *  encode failed; the doc then simply has no deep-extraction path). */
  mediaRef: string;
  mimeType?: string;
  filename?: string;
  /** Epoch-ms send time of the carrying message (drives createdAt). */
  sentAtMs: number;
}

export type WhatsAppItem = DayItem | FileItem;
