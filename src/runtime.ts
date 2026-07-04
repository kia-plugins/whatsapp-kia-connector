import type { proto, WASocket } from '@whiskeysockets/baileys';

import { dayKey, mergeMessages } from './chat-day';
import { ContactBook } from './contacts';
import type { Batch, LogLevel } from './kiagent-contracts';
import { MEDIA_SIZE_CAP_BYTES } from './media';
import { normalizeWAMessage } from './messages';
import { AsyncBatchQueue } from './queue';
import { WhatsAppSocket } from './socket';
import type {
  ChatInfo,
  DayItem,
  NormalizedMessage,
  WhatsAppCursor,
  WhatsAppItem,
} from './types';

/** How long to coalesce a burst of ingests before flushing a batch. */
const FLUSH_DEBOUNCE_MS = 1500;

export type WhatsAppBatch = Batch<WhatsAppCursor, WhatsAppItem>;

export interface PullRuntimeDeps {
  /** Injected socket factory (test seam). MUST return a FRESH socket per
   *  call — the reconnect path relies on a brand-new event emitter. */
  makeSocket: () => WASocket;
  /** Persist the auth blob; wired to every Baileys creds.update (signal keys
   *  rotate mid-session; a restart with stale keys loses the session). */
  saveCreds: () => Promise<void>;
  /** Fetch decrypted media bytes for a message; null ⇒ keep the placeholder. */
  downloadMedia: (wm: proto.IWebMessageInfo) => Promise<Buffer | null>;
  /** Bare self JID ('<user>@s.whatsapp.net') so own messages read "You". */
  selfJid: string;
  /** Cursor floor from the previous run. */
  initialLastTsMs: number;
  /**
   * The store's prior ledger for a chat-day externalId ('<jid>:<YYYY-MM-DD>'),
   * or null. Fetched ONCE per (chat, day) per run and merged into the
   * in-memory ledger — this replaces v1's read-modify-write and survives
   * restarts where Baileys does NOT re-deliver old messages.
   */
  loadPriorMessages: (externalId: string) => Promise<NormalizedMessage[] | null>;
  log: (level: LogLevel, msg: string) => void;
  /** Debounce for the auto-flush after an ingest burst. Default 1500ms. */
  flushDebounceMs?: number;
  /** Reconnect backoff seams (see WhatsAppSocket). */
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
}

/** In-memory ledger for one (chat, local day). */
interface DayLedger {
  jid: string;
  day: string;
  byId: Map<string, NormalizedMessage>;
}

/** A media message whose bytes download in the background, off the text path. */
interface PendingMedia {
  jid: string;
  day: string;
  msgId: string;
  wm: proto.IWebMessageInfo;
  filename?: string;
  mimeType?: string;
  sentAtMs: number;
}

/**
 * The live WhatsApp runtime behind pull(): owns the one socket, the contact
 * book, per-(chat, day) message ledgers, and a background media-download
 * queue; emits ready-to-yield Batches into an AsyncBatchQueue that the pull()
 * generator drains.
 *
 * Ingest is text-only and fast: it normalizes messages into the ledgers and
 * queues any media for a SEPARATE background download — a large history sync
 * materializes into chat-day batches within seconds instead of stalling
 * behind per-message media fetches. After each ingest a debounced flush
 * builds one batch of every touched day; media bytes download one at a time
 * and each emits a follow-up batch of [day re-emit, file item].
 *
 * All batch-building (flush + media emit) is serialized through ONE promise
 * chain so two builders can never interleave a day's prior-merge mid-batch.
 */
export class WhatsAppPullRuntime {
  private readonly queue = new AsyncBatchQueue<WhatsAppBatch>();

  private readonly socket: WhatsAppSocket;

  private readonly book: ContactBook;

  private readonly ledgers = new Map<string, DayLedger>();

  /** Day keys touched since their last emit. */
  private readonly dirty = new Set<string>();

  /** Day keys whose prior store ledger has been fetched this run. */
  private readonly priorFetched = new Set<string>();

  /** Serializes flush + media emits (see class doc). Kept alive past
   *  rejections so one failed task can't wedge the chain. */
  private chain: Promise<unknown> = Promise.resolve();

  private readonly mediaQueue: PendingMedia[] = [];

  private mediaRunning = false;

  /** Settles when the background media drain is idle (awaited by stop()). */
  private mediaIdle: Promise<unknown> = Promise.resolve();

  private flushTimer?: ReturnType<typeof setTimeout>;

  /** Guards against opening more than one Baileys socket. A second socket
   *  would share the ONE signal key store (session corruption) and run two
   *  simultaneous live connections (a ban signal). */
  private started = false;

  private closed = false;

  private stopping?: Promise<void>;

  /** Flips on the first normalized messages.upsert message; from then on
   *  every batch is phase 'live'. History-set batches before that are
   *  'backfill'. */
  private liveSeen = false;

  private lastTsMs: number;

  /** The socket reported a 401 logout — terminal; pull() throws after drain. */
  loggedOut = false;

  constructor(private readonly deps: PullRuntimeDeps) {
    this.lastTsMs = deps.initialLastTsMs;
    this.book = new ContactBook(deps.selfJid);
    this.socket = new WhatsAppSocket({
      makeSocket: deps.makeSocket,
      reconnectBaseMs: deps.reconnectBaseMs,
      reconnectCapMs: deps.reconnectCapMs,
      onQr: () => {
        // A QR during pull means the session is unpaired — treat as logout so
        // the account surfaces "reconnect" instead of silently idling.
        this.deps.log('warn', 'whatsapp: socket asked for a QR mid-sync — session is gone, re-pair required');
        this.loggedOut = true;
        void this.stop();
      },
      onConnected: () => {
        void this.deps.saveCreds().catch((e) =>
          this.deps.log('warn', `whatsapp: creds persist failed: ${errText(e)}`),
        );
      },
      onLoggedOut: () => {
        this.loggedOut = true;
        void this.stop();
      },
      onCredsUpdate: () => {
        void this.deps.saveCreds().catch((e) =>
          this.deps.log('warn', `whatsapp: creds persist failed: ${errText(e)}`),
        );
      },
      onMessages: (u) =>
        this.ingest(
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
        this.ingest(hh.messages ?? [], 'history');
      },
      onContacts: (c) => this.absorbContacts(c, undefined),
    });
  }

  /** Open the single socket, at most once. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.socket.start();
  }

  /** Next ready batch; null once stopped and drained (pull() then returns). */
  nextBatch(): Promise<WhatsAppBatch | null> {
    return this.queue.next();
  }

  /**
   * Shut down: stop the socket (cancels any queued reconnect), let an
   * in-flight media download settle, flush whatever is still buffered as a
   * final batch, then close the queue so nextBatch() drains to null.
   * Idempotent — abort listener, loggedOut and pull()'s finally all call it.
   */
  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.socket.stop();
    await this.mediaIdle.catch(() => {});
    await this.enqueue(() => this.doFlush()).catch(() => {});
    this.queue.close();
  }

  /**
   * Feed the contact book from Baileys' contacts/chats payloads so day docs
   * read "Alice:" instead of "+49…". Individual contacts carry
   * name/notify/verifiedName; `chats` carries group subjects under the same
   * id→name shape.
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

  /** Ledger text immediately; queue any media for a background download. */
  private ingest(
    messages: proto.IWebMessageInfo[],
    kind: 'live' | 'history',
  ): void {
    if (this.closed) return;
    for (const wm of messages) {
      const jid = wm.key?.remoteJid;
      // Skip statuses/stories (status@broadcast) and messages without a chat.
      if (!jid || jid === 'status@broadcast') continue;
      // Learn the sender's display name from the message itself (pushName is
      // the most reliable per-message source) before normalize reads it.
      const senderJid = jid.endsWith('@g.us')
        ? wm.key?.participant
        : wm.key?.fromMe
          ? undefined
          : jid;
      if (!wm.key?.fromMe && senderJid && wm.pushName)
        this.book.set(senderJid, wm.pushName);

      const norm = normalizeWAMessage(wm, this.book, jid);
      if (!norm) continue;
      if (kind === 'live') this.liveSeen = true;

      const day = dayKey(norm.tsMs);
      const key = `${jid}:${day}`;
      let ledger = this.ledgers.get(key);
      if (!ledger) {
        ledger = { jid, day, byId: new Map() };
        this.ledgers.set(key, ledger);
      }
      ledger.byId.set(norm.id, norm); // incoming wins on conflict
      this.dirty.add(key);
      if (norm.tsMs > this.lastTsMs) this.lastTsMs = norm.tsMs;

      if (norm.media) {
        this.mediaQueue.push({
          jid,
          day,
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

  /** Debounced auto-flush so batches appear within seconds of a burst. */
  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.enqueue(() => this.doFlush()).catch((e) =>
        this.deps.log('warn', `whatsapp: flush failed: ${errText(e)}`),
      );
    }, this.deps.flushDebounceMs ?? FLUSH_DEBOUNCE_MS);
    // Don't hold the event loop open just for a pending flush.
    this.flushTimer.unref?.();
  }

  /**
   * Run `fn` after all previously-enqueued batch-building completes. The
   * chain is kept alive past rejections so one failed task can't wedge it.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private phase(): 'backfill' | 'live' {
    return this.liveSeen ? 'live' : 'backfill';
  }

  private push(items: WhatsAppItem[]): void {
    this.queue.push({
      phase: this.phase(),
      items,
      cursor: { lastTsMs: this.lastTsMs },
    });
  }

  /** One batch containing every dirty day's complete merged item. */
  private async doFlush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const items: WhatsAppItem[] = [];
    for (const key of [...this.dirty]) {
      const item = await this.buildDayItem(key);
      if (!item) continue; // prior-load failed: stays dirty, retried next flush
      this.dirty.delete(key);
      items.push(item);
    }
    if (items.length > 0) this.push(items);
  }

  private chatInfoFor(jid: string): ChatInfo {
    return {
      jid,
      // Re-resolve on every build so a name learned after the ledger was
      // first seen is picked up.
      name: this.book.name(jid) ?? jid,
      type: jid.endsWith('@g.us') ? 'group' : 'dm',
    };
  }

  /**
   * The complete merged item for one (chat, day): union of this run's ledger
   * and the store's prior metadata.messages (fetched once per key per run).
   * Returns null when the prior fetch fails — the caller leaves the day dirty
   * and a later flush retries, so a transient store error can never emit a
   * day item MISSING messages the store already had (metadata.messages is the
   * durable ledger; emitting a subset would shrink it).
   */
  private async buildDayItem(key: string): Promise<DayItem | null> {
    const ledger = this.ledgers.get(key);
    if (!ledger) return null;
    if (!this.priorFetched.has(key)) {
      let prior: NormalizedMessage[] | null;
      try {
        prior = await this.deps.loadPriorMessages(key);
      } catch (e) {
        this.deps.log(
          'warn',
          `whatsapp: prior chat-day read failed for ${key}: ${errText(e)} — will retry`,
        );
        return null;
      }
      this.priorFetched.add(key);
      if (prior && prior.length > 0) {
        const merged = mergeMessages(prior, [...ledger.byId.values()]);
        ledger.byId = new Map(merged.map((m) => [m.id, m]));
      }
    }
    const messages = [...ledger.byId.values()].sort(
      (a, b) => a.tsMs - b.tsMs || a.id.localeCompare(b.id),
    );
    return { kind: 'day', chat: this.chatInfoFor(ledger.jid), day: ledger.day, messages };
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
   * Download queued media ONE at a time (gentle on WhatsApp — concurrent
   * media fetches read as abnormal-client behavior and raise ban risk), then
   * emit a batch of [day re-emit, file item] through the chain. The parent
   * day rides the same batch so the engine can resolve the parent edge
   * in-transaction even if the day's first batch was somehow lost;
   * re-emitting is idempotent (upsert by externalId).
   */
  private async drainMedia(): Promise<void> {
    while (this.mediaQueue.length && !this.closed) {
      const item = this.mediaQueue.shift()!;
      try {
        const bytes = await this.deps.downloadMedia(item.wm);
        if (!bytes || bytes.length > MEDIA_SIZE_CAP_BYTES) continue;
        await this.enqueue(() => this.emitMediaBatch(item, bytes));
      } catch (e) {
        // Download/emit failed → the day doc keeps its media placeholder.
        this.deps.log(
          'warn',
          `whatsapp: media ${item.msgId} skipped: ${errText(e)}`,
        );
      }
    }
  }

  private async emitMediaBatch(m: PendingMedia, bytes: Buffer): Promise<void> {
    const key = `${m.jid}:${m.day}`;
    const day = await this.buildDayItem(key);
    if (!day) {
      this.deps.log(
        'warn',
        `whatsapp: media ${m.msgId} dropped — no day ledger for ${key}`,
      );
      return;
    }
    // The media emit carries the day's complete current state — it IS a flush
    // of that day, so clear its dirty mark.
    this.dirty.delete(key);
    const file: WhatsAppItem = {
      kind: 'file',
      chatJid: m.jid,
      day: m.day,
      msgId: m.msgId,
      bytes,
      mimeType: m.mimeType,
      filename: m.filename,
      sentAtMs: m.sentAtMs,
    };
    this.push([day, file]);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
