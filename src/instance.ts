// src/main/connectors/whatsapp/instance.ts
import type { Host, Db, Converter } from './host';
import type { proto, WASocket } from '@whiskeysockets/baileys';
import { ContactBook } from './contacts';
import { WhatsAppSocket } from './socket';
import { normalizeWAMessage } from './messages';
import { upsertChatDays, relinkChatDayMedia, dayKey } from './chat-day';
import { storeMedia, sweepMediaCache, MEDIA_SIZE_CAP_BYTES } from './media';
import type { ChatRef, NormalizedMessage } from './types';

/** How long to coalesce a burst of ingests before writing chat-day docs. */
const FLUSH_DEBOUNCE_MS = 1500;

export interface RuntimeDeps {
  ctx: Host;
  accountId: bigint;
  selfJid: string;
  mediaDir: string;
  makeSocket: () => WASocket;
  /** Fetch decrypted media bytes for a message; null ⇒ leave a placeholder. */
  downloadMedia: (wm: proto.IWebMessageInfo) => Promise<Buffer | null>;
  onQr?: (qr: string) => void;
  onConnected?: () => void;
  /** Persist Baileys creds/keys on every change (signal keys rotate mid-session). */
  onCredsUpdate?: () => void;
  /** Debounce window for the auto-flush after an ingest burst. Default 1500ms. */
  flushDebounceMs?: number;
}

/** A media message whose bytes download in the background, off the text path. */
interface PendingMedia {
  jid: string;
  dayKey: string;
  msgId: string;
  wm: proto.IWebMessageInfo;
  filename?: string;
  mimeType?: string;
  sentAtMs: number;
}

/**
 * The live WhatsApp runtime: owns the socket, contact book, a per-chat buffer of
 * normalized text, and a background media-download queue.
 *
 * Ingest is text-only and fast: it normalizes messages into the buffer and
 * queues any media for a SEPARATE background download — so a large history sync
 * (thousands of messages) materializes into whatsapp_chat_day docs within
 * seconds instead of stalling behind per-message media fetches. After each
 * ingest a debounced flush writes the day docs; media bytes download in the
 * background and, when ready, re-link their day doc's `[Attachment]`.
 *
 * Scheduler lifecycle maps on as: startRealtime/startBackfill open the one
 * socket; pollDelta is the cadence tick (flush + sweep the media cache) which
 * throws an auth error once the socket reports a logout so the scheduler flips
 * the account to needs_reauth.
 */
export class WhatsAppRuntime {
  private socket: WhatsAppSocket;

  private book: ContactBook;

  private loggedOut = false;

  /** Guards against opening more than one Baileys socket (see ensureStarted). */
  private started = false;

  /** Set on shutdown so background loops/timers stop scheduling more work. */
  private closed = false;

  /**
   * Serializes all document writes (flush + media re-link) through a promise
   * chain so concurrent writers can never interleave a chat-day's read-modify-
   * write. The chain is kept alive past rejections so one failure can't wedge it.
   */
  private chain: Promise<unknown> = Promise.resolve();

  /** Per-chat buffer of normalized messages awaiting the next flush. */
  private buffer = new Map<string, NormalizedMessage[]>();

  /** Media awaiting a background byte download (kept off the text path). */
  private mediaQueue: PendingMedia[] = [];

  /** Resolved media: message id → file doc id, used to (re)link day docs. */
  private attachments = new Map<string, string>();

  private mediaRunning = false;

  /** Settles when the background media drain is idle (awaited by shutdown). */
  private mediaIdle: Promise<unknown> = Promise.resolve();

  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: RuntimeDeps) {
    this.book = new ContactBook(deps.selfJid);
    this.socket = new WhatsAppSocket({
      makeSocket: deps.makeSocket,
      onQr: (qr) => deps.onQr?.(qr),
      onConnected: () => deps.onConnected?.(),
      onLoggedOut: () => {
        this.loggedOut = true;
      },
      onCredsUpdate: () => deps.onCredsUpdate?.(),
      onMessages: (u) =>
        this.onIncoming(
          (u as { messages?: proto.IWebMessageInfo[] }).messages ?? [],
          'live',
        ),
      onHistory: (h) => {
        const hh = h as {
          messages?: proto.IWebMessageInfo[];
          contacts?: unknown[];
          chats?: unknown[];
        };
        this.absorbContacts(hh.contacts, hh.chats);
        this.onIncoming(hh.messages ?? [], 'history');
      },
      onContacts: (c) => this.absorbContacts(c, undefined),
    });
  }

  /**
   * Feed the contact book from Baileys' contacts/chats payloads so day docs read
   * "Alice:" instead of "+49…". Individual contacts carry name/notify/verifiedName;
   * `chats` carries group subjects under the same id→name shape.
   */
  private absorbContacts(contacts?: unknown[], chats?: unknown[]): void {
    for (const c of contacts ?? []) {
      const r = c as {
        id?: string;
        name?: string;
        notify?: string;
        verifiedName?: string;
      };
      if (r?.id) this.book.set(r.id, r.name ?? r.notify ?? r.verifiedName);
    }
    for (const ch of chats ?? []) {
      const r = ch as { id?: string; name?: string };
      if (r?.id && r?.name) this.book.set(r.id, r.name);
    }
  }

  private onIncoming(
    messages: proto.IWebMessageInfo[],
    kind: 'live' | 'history',
  ): void {
    void this.enqueue(() => this.ingest(messages)).catch((e) =>
      console.error(`[whatsapp] ${kind} ingest failed:`, e),
    );
  }

  /**
   * Run `fn` after all previously-enqueued document work completes. Serializes
   * ingest, flush, and media re-link so they never overlap. The chain is kept
   * alive past rejections so one failed task can't wedge the queue.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * Open the single Baileys socket, at most once. Opening the socket IS the
   * backfill: history sync arrives via messaging-history.set after 'open'. So
   * whichever of startBackfill/startRealtime runs first opens the one socket;
   * the other is a no-op. A second socket would share the ONE Signal key store
   * (session corruption) and run two simultaneous live connections (a ban
   * signal), so this guard is load-bearing. Do NOT push it into
   * WhatsAppSocket.start() — its reconnect path deliberately re-calls start().
   */
  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.socket.start();
  }

  async startRealtime(): Promise<void> {
    await this.ensureStarted();
  }

  async startBackfill(): Promise<void> {
    await this.ensureStarted();
  }

  private chatRefFor(jid: string): ChatRef {
    const group = jid.endsWith('@g.us');
    return {
      keyKind: 'jid',
      key: jid,
      name: this.book.name(jid) ?? jid,
      type: group ? 'group' : 'dm',
    };
  }

  /** Buffer text immediately; queue any media for a background download. */
  private async ingest(messages: proto.IWebMessageInfo[]): Promise<void> {
    for (const wm of messages) {
      const jid = wm.key?.remoteJid;
      // Skip statuses/stories (status@broadcast) and any message without a chat.
      if (!jid || jid === 'status@broadcast') continue;
      // Learn the sender's display name from the message itself (pushName is the
      // most reliable per-message source) before normalize reads it.
      const senderJid = jid.endsWith('@g.us')
        ? wm.key?.participant
        : wm.key?.fromMe
          ? undefined
          : jid;
      if (!wm.key?.fromMe && senderJid && wm.pushName)
        this.book.set(senderJid, wm.pushName);

      const norm = normalizeWAMessage(wm, this.book, jid);
      if (!norm) continue;
      const slot = this.buffer.get(jid) ?? [];
      slot.push(norm);
      this.buffer.set(jid, slot);

      if (norm.media) {
        this.mediaQueue.push({
          jid,
          dayKey: dayKey(norm.tsMs),
          msgId: norm.id,
          wm,
          filename: norm.media.filename,
          mimeType: norm.media.mimeType,
          sentAtMs: norm.tsMs,
        });
      }
    }
    this.scheduleFlush();
    this.kickMedia();
  }

  /** Debounced auto-flush so docs appear within seconds of an ingest burst. */
  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((e) =>
        console.error('[whatsapp] auto-flush failed:', e),
      );
    }, this.deps.flushDebounceMs ?? FLUSH_DEBOUNCE_MS);
    // Don't hold the event loop / process open just for a pending flush.
    this.flushTimer.unref?.();
  }

  /** Public flush: serialized through the chain so it never overlaps a write. */
  async flush(): Promise<void> {
    await this.enqueue(() => this.doFlush());
  }

  private async doFlush(): Promise<void> {
    for (const [jid, messages] of this.buffer) {
      if (!messages.length) continue;
      // Re-resolve the chat (name/type) each flush so a contact name learned
      // after the slot was first seen is picked up.
      await upsertChatDays({
        ctx: this.deps.ctx,
        accountId: this.deps.accountId,
        chat: this.chatRefFor(jid),
        messages,
        attachmentDocId: (id) => this.attachments.get(id),
      });
    }
    // Day docs persist the merged messages in metadata, and media re-link reads
    // them back from there — so the buffer can be cleared. A later live message
    // for the same day re-reads the prior doc and merges (no loss).
    this.buffer.clear();
  }

  /** Start the background media drain if it isn't already running. */
  private kickMedia(): void {
    if (this.mediaRunning || this.closed) return;
    this.mediaRunning = true;
    this.mediaIdle = this.drainMedia().finally(() => {
      this.mediaRunning = false;
      // Items queued during the gap between the loop ending and the flag
      // resetting would otherwise sit until the next ingest — restart.
      if (this.mediaQueue.length && !this.closed) this.kickMedia();
    });
  }

  /**
   * Download queued media one at a time (gentle on WhatsApp — concurrent media
   * fetches read as abnormal-client behavior and raise ban risk), store the
   * bytes + emit a file doc, then re-link the owning day doc. The download and
   * store run OFF the document-write chain so they never block flush; only the
   * re-link (a quick DB read-modify-write) goes through the chain.
   */
  private async drainMedia(): Promise<void> {
    while (this.mediaQueue.length && !this.closed) {
      const item = this.mediaQueue.shift()!;
      try {
        const bytes = await this.deps.downloadMedia(item.wm);
        if (!bytes || bytes.length > MEDIA_SIZE_CAP_BYTES) continue;
        const docId = await storeMedia({
          ctx: this.deps.ctx,
          accountId: this.deps.accountId,
          baseDir: this.deps.mediaDir,
          converter: this.deps.ctx.converter as Converter,
          chatKey: item.jid,
          msgId: item.msgId,
          sentAtMs: item.sentAtMs,
          bytes,
          filename: item.filename,
          mimeType: item.mimeType,
        });
        this.attachments.set(item.msgId, docId);
        await this.enqueue(() =>
          relinkChatDayMedia(
            this.deps.ctx,
            `${item.jid}:${item.dayKey}`,
            (id) => this.attachments.get(id),
          ),
        );
      } catch {
        /* download/store failed → the day doc keeps its media placeholder */
      }
    }
  }

  async pollDelta(): Promise<void> {
    // The socket reported a logout (401). Surface an error shaped so the
    // scheduler's isAuthError() recognizes it (both a `.status === 401` field
    // and a `401`/`unauthenticated` message) and flips the account to
    // needs_reauth instead of retrying a dead session forever.
    if (this.loggedOut) {
      const err = new Error(
        'whatsapp: logged out (401 unauthenticated) — re-pair required',
      ) as Error & { status: number };
      err.status = 401;
      throw err;
    }
    await this.flush();
    await sweepMediaCache(this.deps.ctx.db as Db, this.deps.mediaDir);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.socket.stop();
    // Let an in-flight media download/store settle so we don't leak it past
    // teardown, then write whatever text is still buffered.
    await this.mediaIdle.catch(() => {});
    await this.flush();
  }
}
