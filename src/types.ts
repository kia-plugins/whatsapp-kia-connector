// src/main/connectors/whatsapp/types.ts

/** A single chat message after normalization from either ingest path. */
export interface NormalizedMessage {
  /** Stable id: WhatsApp message id (live) or hash(ts+sender+text) (import). */
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
  /** Original filename if known (Android exports / document messages). */
  filename?: string;
  /** Mime type if known. */
  mimeType?: string;
  /** Duration seconds for audio/video, for the placeholder label. */
  durationSec?: number;
}

/** Identifies a chat across both paths. JID for live; name-derived for import. */
export interface ChatRef {
  /** 'jid' for live messages; 'name' for imports not yet resolved to a JID. */
  keyKind: 'jid' | 'name';
  /** The chat JID (live) or a slug of the chat name (import). */
  key: string;
  /** Human chat title. */
  name: string;
  type: 'dm' | 'group';
}

/** sync_state.cursor_json shape for the live connector. */
export interface WhatsAppCursor {
  /** Highest message timestamp (ms) we have ingested, for checkpointing. */
  lastTsMs?: number;
}
