import { DisconnectReason, generateMessageID } from '@whiskeysockets/baileys';
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
    /** Sync percentage when WhatsApp includes it; 100 marks the final chunk
     *  of a full history sync. Recent-only syncs may never send it. */
    progress?: number | null;
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

function errText(e: unknown): string {
  if (e === undefined || e === null) return 'no error';
  return e instanceof Error ? e.message : String(e);
}

/** The server's acknowledgement of a message this socket sent. */
/** The one "provably unsent: no open socket" wording (kiagent-core
 *  error-copy.ts `not sent:`), shared by socket, runtime and sender. */
export const NOT_CONNECTED = "not sent: WhatsApp isn't connected right now — try again in a moment";
const ACK_EVENT = 'CB:ack,class:message';

interface AckNode {
  attrs?: { id?: string; error?: string };
}

/** Owns one Baileys socket and translates its events into callbacks. */
export class WhatsAppSocket {
  private sock?: WASocket;

  private closed = false;

  /** True between `connection: 'open'` and the next close/stop — the only
   *  window in which a send may start. */
  private open = false;

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
        this.open = true;
        // Healthy session: reset backoff so a later drop retries from scratch.
        this.reconnectAttempts = 0;
        this.deps.onConnected();
      }
      if (u.connection === 'close') {
        this.open = false;
        const code = statusCodeOf(u.lastDisconnect?.error);
        // DisconnectReason.loggedOut === 401; the extra literal is
        // belt-and-suspenders for fakes/forks that emit a bare 401.
        if (code === DisconnectReason.loggedOut || code === 401) {
          this.deps.onLoggedOut();
        } else if (!this.closed) {
          // The status code is the whole diagnosis when a reconnect loop runs
          // for hours (a rejected protocol version and a wedged network look
          // identical without it), and Baileys never logs it. Warn, don't
          // error: a single drop is routine.
          this.deps.onLog?.(
            'warn',
            `whatsapp: connection closed (statusCode ${code ?? 'none'}: ${
              errText(u.lastDisconnect?.error)
            }) — reconnecting`,
          );
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

  get isOpen(): boolean {
    return this.open && !this.closed;
  }

  /**
   * Send one text message on the CURRENT socket and resolve with its id only
   * once WhatsApp's server ACKNOWLEDGED it — `sendMessage` resolving means
   * the stanza was written, not accepted. The ack listener is attached before
   * sending, under a pre-generated id.
   *
   * One deadline covers preparation (device/group lookups can take up to
   * Baileys' 60 s query timeout) AND the ack. At the deadline the socket is
   * ENDED — the runtime reconnects on its own — so a send still being
   * prepared can never go out after the caller was told it failed.
   */
  sendText(jid: string, text: string, deadlineMs: number): Promise<string> {
    const sock = this.sock;
    if (!sock || !this.isOpen)
      return Promise.reject(
        new Error(NOT_CONNECTED),
      );
    const id = generateMessageID();
    const ws = sock.ws as unknown as {
      on(ev: string, cb: (node: AckNode) => void): void;
      off(ev: string, cb: (node: AckNode) => void): void;
    };
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.off(ACK_EVENT, onAck);
        fn();
      };
      const onAck = (node: AckNode): void => {
        if (node?.attrs?.id !== id) return;
        const error = node.attrs.error;
        finish(() =>
          error
            ? reject(new Error(`WhatsApp answered the message with error ${error}`))
            : resolve(id),
        );
      };
      const timer = setTimeout(
        () =>
          finish(() => {
            try {
              sock.end(new Error('whatsapp: send deadline passed'));
            } catch {
              /* already down */
            }
            reject(new Error('WhatsApp did not confirm the message in time'));
          }),
        deadlineMs,
      );
      ws.on(ACK_EVENT, onAck);
      sock
        .sendMessage(jid, { text }, { messageId: id })
        .catch((e: unknown) =>
          finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
        );
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.open = false;
    // Cancel any queued reconnect so it can't fire after an intentional stop.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore — socket may already be torn down */
    }
  }
}
