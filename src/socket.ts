import { DisconnectReason } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';

export interface WhatsAppSocketDeps {
  /**
   * Injected so tests pass a fake; production passes a real makeWASocket call.
   * MUST return a FRESH socket on every call: the reconnect path relies on a
   * brand-new event emitter so old handlers don't leak onto a reused socket.
   */
  makeSocket: () => WASocket;
  /** Base reconnect delay (ms) for the exponential backoff. Default 250. */
  reconnectBaseMs?: number;
  /** Maximum reconnect delay (ms) the backoff is capped at. Default 30_000. */
  reconnectCapMs?: number;
  onQr: (qr: string) => void;
  onConnected: () => void;
  onLoggedOut: () => void;
  /**
   * Baileys fires `creds.update` whenever creds OR signal keys change (every
   * message can rotate keys). Persist on each one — `onConnected` alone is
   * insufficient because keys keep rotating after the initial open, and a
   * restart with stale keys loses the session. Optional: import-only callers
   * have nothing to persist.
   */
  onCredsUpdate?: () => void;
  onMessages: (upsert: { messages: unknown[]; type: string }) => void;
  onHistory: (set: {
    chats: unknown[];
    contacts: unknown[];
    messages: unknown[];
  }) => void;
  /** Live contact add/rename (contacts.upsert / contacts.update). Optional. */
  onContacts?: (contacts: unknown[]) => void;
  /** Diagnostics sink (reconnect failures). Defaults to console.error. */
  onLog?: (level: 'warn' | 'error', msg: string) => void;
}

/**
 * The Baileys close `error` is `Boom | Error | undefined`; only Boom carries
 * `output.statusCode`. Narrow through a shaped read rather than importing the
 * transitive `@hapi/boom` type — undefined for a plain Error, which is what the
 * reconnect branch wants (transient → reconnect, not logged-out).
 */
export function statusCodeOf(err: unknown): number | undefined {
  return (err as { output?: { statusCode?: number } } | undefined)?.output
    ?.statusCode;
}

/** Owns one Baileys socket and translates its events into callbacks. */
export class WhatsAppSocket {
  private sock?: WASocket;

  private closed = false;

  private reconnectAttempts = 0;

  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: WhatsAppSocketDeps) {}

  async start(): Promise<void> {
    const sock = this.deps.makeSocket();
    this.sock = sock;
    // `sock.ev` is Baileys' typed BaileysEventEmitter, so each payload below is
    // inferred from BaileysEventMap — no `any` needed.
    sock.ev.on('connection.update', (u) => {
      if (u.qr) this.deps.onQr(u.qr);
      if (u.connection === 'open') {
        // Healthy session: reset backoff so a later drop retries from scratch.
        this.reconnectAttempts = 0;
        this.deps.onConnected();
      }
      if (u.connection === 'close') {
        const code = statusCodeOf(u.lastDisconnect?.error);
        // DisconnectReason.loggedOut === 401; the extra literal is
        // belt-and-suspenders for fakes/forks that emit a bare 401.
        if (code === DisconnectReason.loggedOut || code === 401) {
          this.deps.onLoggedOut();
        } else if (!this.closed) {
          // Transient close: the old socket is dead. Real Baileys discards it,
          // so the reconnect makes a fresh socket (new emitter) via the
          // factory — no handler accumulates on a reused emitter.
          this.scheduleReconnect();
        }
      }
    });
    sock.ev.on('messages.upsert', (u) => this.deps.onMessages(u));
    sock.ev.on('messaging-history.set', (h) => this.deps.onHistory(h));
    sock.ev.on('creds.update', () => this.deps.onCredsUpdate?.());
    // Live contact add/rename so day docs pick up names that arrive after the
    // initial history sync. Both events carry an array of {id, name?, notify?}.
    sock.ev.on('contacts.upsert', (c) => this.deps.onContacts?.(c));
    sock.ev.on('contacts.update', (c) => this.deps.onContacts?.(c));
  }

  /**
   * Schedule a reconnect with exponential backoff + full jitter, capped.
   * A reconnect storm against a fast-failing/RST-ing server looks like an
   * abnormal client to WhatsApp and can SPEED UP an account ban, so we space
   * attempts out and bound them by the cap.
   */
  private scheduleReconnect(): void {
    const base = this.deps.reconnectBaseMs ?? 250;
    const cap = this.deps.reconnectCapMs ?? 30_000;
    const delay = Math.min(cap, base * 2 ** this.reconnectAttempts);
    // Full jitter at 50–100% of delay: desynchronizes retries while staying
    // bounded by the cap. Math.random is fine here (jitter, not security).
    const wait = Math.round(delay * (0.5 + Math.random() * 0.5));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed)
        void this.start().catch((e) => {
          const msg = `whatsapp: reconnect failed: ${
            e instanceof Error ? e.message : String(e)
          }`;
          if (this.deps.onLog) this.deps.onLog('error', msg);
          else console.error(msg);
          // A failed (re)start must not strand the socket as a silent zombie:
          // keep retrying under the same jittered backoff (attempts keep
          // incrementing, so the delay keeps growing toward the cap).
          if (!this.closed) this.scheduleReconnect();
        });
    }, wait);
  }

  async stop(): Promise<void> {
    this.closed = true;
    // Cancel any queued reconnect so it can't fire after an intentional stop.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore — socket may already be torn down */
    }
  }
}
