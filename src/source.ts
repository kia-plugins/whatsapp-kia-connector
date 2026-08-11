/**
 * WhatsApp v2 source: QR pairing in connect() (auth blob persisted under the
 * extension's dataDir — see the README privacy note on plaintext storage),
 * and a pull() that owns one long-lived Baileys socket per account and never
 * returns while healthy: history sync streams in as 'backfill' batches, live
 * messages as 'live' batches, media bytes as parented `file` items. The
 * engine drains the iterable with no per-batch timeout — the open generator
 * IS the realtime path.
 */
import path from 'node:path';

import makeWASocket, {
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import type { AuthenticationState, proto, WASocket } from '@whiskeysockets/baileys';

import { SourceAuthError } from '@kiagent/connector-sdk';
import type {
  AuthChannel,
  Batch,
  Document,
  DocumentInput,
  HostFor,
  Session,
  Source,
} from '@kiagent/connector-sdk';

import {
  fileVersionCache,
  VersionResolver,
  type VersionLog,
} from './version';

import {
  loadAuthState,
  makeFreshAuthState,
  plaintextCodec,
  type AuthBlobCodec,
} from './auth-state';
import { DOC_TYPE, dayTitle, renderDay } from './chat-day';
import { normalizeJid } from './contacts';
import {
  attachmentFilename,
  decodeMediaRef,
  defaultDownloadMedia,
  extFromMime,
  FILE_DOC_TYPE,
  MEDIA_SIZE_CAP_BYTES,
  normalizeMime,
} from './media';
import { pairAndWaitOpen } from './pair';
import { WhatsAppPullRuntime } from './runtime';
import type { NormalizedMessage, WhatsAppCursor, WhatsAppItem } from './types';

export type WhatsAppHost = HostFor<'net' | 'query'>;

/** Test seams — production callers omit all of these. */
export interface WhatsAppSourceSeams {
  /** Socket factory factory: resolves Baileys version, returns the per-
   *  (re)connect socket maker. Tests return a fake-socket maker. The optional
   *  log carries version diagnostics into the account's session log. */
  makeSocketFactory?: (
    auth: AuthenticationState,
    log?: VersionLog,
  ) => Promise<() => WASocket>;
  downloadMedia?: (
    wm: proto.IWebMessageInfo,
    signal: AbortSignal,
  ) => Promise<Buffer | null>;
  /** Auth-blob encryption seam (default plaintext — see auth-state.ts). */
  codec?: AuthBlobCodec;
  flushDebounceMs?: number;
  catchUpQuietMs?: number;
  pairingTimeoutMs?: number;
  mediaTimeoutMs?: number;
  stopMediaWaitMs?: number;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
}

/**
 * WhatsApp terminates registrations that advertise a Desktop sub-platform
 * (DARWIN/WIN32) since 2026-07 — `Browsers.appropriate('Desktop')` closes
 * with 428 "Connection Terminated" before any QR is issued (WhiskeySockets/
 * Baileys#2677). A WEB_BROWSER identity pairs fine; the linked device shows
 * up as "Chrome (Ubuntu)" on the phone.
 */
export const PAIRING_BROWSER = Browsers.ubuntu('Chrome');

/** Last-known-good protocol version, under the extension's dataDir. */
export const VERSION_CACHE_FILE = 'wa-version.json';

/**
 * Production socket factory. One resolver per source instance, so every account
 * and every reconnect shares the same (refreshing) protocol version — see
 * version.ts for the two outages that shaped this.
 */
export function createDefaultSocketFactory(
  dataDir: string,
): (auth: AuthenticationState, log?: VersionLog) => Promise<() => WASocket> {
  const resolver = new VersionResolver({
    cache: fileVersionCache(path.join(dataDir, VERSION_CACHE_FILE)),
    fetchVersion: () => fetchLatestBaileysVersion().then((r) => r.version),
  });

  return async (auth, log) => {
    await resolver.init(log);
    return () => {
      // Read per (re)connect, not once per session: a session that opened
      // during a network outage heals on its next reconnect instead of
      // reusing a captured bad version until the engine restarts it.
      const version = resolver.current();
      const sock = makeWASocket({
        // Omit the key ENTIRELY when there's no version. makeWASocket spreads
        // `{...DEFAULT_CONNECTION_CONFIG, ...config}`, so an explicit
        // `undefined` overwrites the baked-in default rather than falling back
        // to it, and getUserAgent then throws on config.version[0].
        ...(version ? { version } : {}),
        auth,
        browser: PAIRING_BROWSER,
        syncFullHistory: true,
      });
      // A reached 'open' is the only proof WhatsApp still accepts this version.
      // Extra listener on a socket that is discarded at every reconnect — the
      // emitter is fresh per call, so nothing accumulates.
      sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') resolver.noteAccepted(version);
      });
      return sock;
    };
  };
}

/** '4917012345@s.whatsapp.net' → a safe blob filename stem. */
function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 'report.pdf' → 'pdf'; undefined when there's no usable extension. */
function extOf(filename?: string): string | undefined {
  const m = filename ? /\.([A-Za-z0-9]+)$/.exec(filename) : null;
  return m ? m[1].toLowerCase() : undefined;
}

const NOT_PAIRED = 'whatsapp: not paired — reconnect the account';

export function createWhatsAppSource(
  host: WhatsAppHost,
  seams: WhatsAppSourceSeams = {},
): Source<WhatsAppCursor, WhatsAppItem> {
  const makeSocketFactory =
    seams.makeSocketFactory ?? createDefaultSocketFactory(host.self.dataDir);
  const downloadMedia = seams.downloadMedia ?? defaultDownloadMedia;
  const codec = seams.codec ?? plaintextCodec;

  return {
    descriptor: {
      id: 'whatsapp',
      name: 'WhatsApp',
      documentTypes: [DOC_TYPE, FILE_DOC_TYPE],
      auth: 'pairing',
      multiAccount: true,
      cadence: { every: '15m' },
    },

    async connect(auth: AuthChannel) {
      // Fresh unregistered creds, in memory until pairing succeeds — no
      // half-paired blob ever lands on disk.
      const pairing = makeFreshAuthState();
      const makeSocket = await makeSocketFactory(pairing.state);
      auth.status(
        'Scan with WhatsApp on your phone: Settings → Linked Devices → Link a Device',
      );
      await pairAndWaitOpen({
        makeSocket,
        onQr: (qr) => auth.showQr(qr), // QR rotates — keep pushing updates
        timeoutMs: seams.pairingTimeoutMs,
      });
      const me = pairing.state.creds.me?.id;
      if (!me) {
        throw new Error('whatsapp pairing did not report an account id — try again');
      }
      // Bare phone-user form: re-pairing the same phone yields the SAME
      // identifier, so the platform upserts the same account and the new
      // blob below overwrites the old (self-healing re-auth).
      const identifier = normalizeJid(me);
      const authFile = `auth/${sanitizeIdentifier(identifier)}.bin`;
      await pairing.save(path.join(host.self.dataDir, authFile), codec);
      auth.status(`Linked ${identifier}. Syncing will start shortly.`);
      return { identifier, config: { authFile } };
    },

    async *pull(
      session: Session,
      cursor: WhatsAppCursor | null,
    ): AsyncGenerator<Batch<WhatsAppCursor, WhatsAppItem>> {
      const authFile = (session.account.config as { authFile?: unknown })
        ?.authFile;
      if (typeof authFile !== 'string' || authFile.length === 0) {
        throw new SourceAuthError(NOT_PAIRED);
      }
      const loaded = loadAuthState(path.join(host.self.dataDir, authFile), {
        codec,
        warn: (msg) => session.log('warn', msg),
      });
      if (!loaded) throw new SourceAuthError(NOT_PAIRED);

      const selfJid = normalizeJid(
        loaded.state.creds.me?.id ?? 'unknown@s.whatsapp.net',
      );
      const makeSocket = await makeSocketFactory(loaded.state, (level, msg) =>
        session.log(level, msg),
      );
      const runtime = new WhatsAppPullRuntime({
        makeSocket,
        saveCreds: loaded.saveCreds,
        downloadMedia,
        selfJid,
        initialLastTsMs: cursor?.lastTsMs ?? 0,
        loadPriorMessages: async (externalId) => {
          const doc = await host.query.byExternalId(
            session.account.id,
            externalId,
            DOC_TYPE,
          );
          const prior = (doc?.metadata as { messages?: unknown })?.messages;
          return Array.isArray(prior) ? (prior as NormalizedMessage[]) : null;
        },
        hasStoredFile: async (externalId) =>
          (await host.query.byExternalId(
            session.account.id,
            externalId,
            FILE_DOC_TYPE,
          )) !== null,
        log: (level, msg) => session.log(level, msg),
        flushDebounceMs: seams.flushDebounceMs,
        catchUpQuietMs: seams.catchUpQuietMs,
        mediaTimeoutMs: seams.mediaTimeoutMs,
        stopMediaWaitMs: seams.stopMediaWaitMs,
        reconnectBaseMs: seams.reconnectBaseMs,
        reconnectCapMs: seams.reconnectCapMs,
      });

      if (session.signal.aborted) return;
      // Abort → stop the socket, final flush lands as the last batch(es),
      // queue closes, the drain loop below ends, generator returns.
      const onAbort = (): void => {
        void runtime.stop();
      };
      session.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await runtime.start();
        for (;;) {
          const batch = await runtime.nextBatch();
          if (batch === null) break;
          yield batch;
        }
      } finally {
        session.signal.removeEventListener('abort', onAbort);
        await runtime.stop();
      }
      if (runtime.loggedOut) {
        // Auth error propagates (engine records lastError, commits
        // needsReauth, stops retrying) — the engine keys off `code`, never
        // `instanceof` or a `.status` shape.
        throw new SourceAuthError(
          'whatsapp: logged out (401 unauthenticated) — reconnect the account',
        );
      }
    },

    toDocument(item: WhatsAppItem): DocumentInput {
      if (item.kind === 'day') {
        const { chat, day, messages } = item;
        const last = messages[messages.length - 1];
        return {
          externalId: `${chat.jid}:${day}`,
          type: DOC_TYPE,
          title: dayTitle(chat.name, day),
          markdown: renderDay(messages),
          url: `whatsapp://chat?jid=${encodeURIComponent(chat.jid)}`,
          metadata: {
            chat_key: chat.jid,
            chat_key_kind: 'jid',
            chat_type: chat.type,
            last_message_at: last ? new Date(last.tsMs).toISOString() : null,
            // Retained in full: the durable per-day ledger the next run
            // merges against (loadPriorMessages).
            messages,
          },
          createdAt: messages[0] ? new Date(messages[0].tsMs).toISOString() : null,
        };
      }
      // Deep-extraction handoff: the platform's vision/audio classifiers key
      // on metadata.mime / sizeBytes / filename / ext — write exactly those
      // (a parameterized 'audio/ogg; codecs=opus' is normalized, a nameless
      // voice note gets a synthetic 'voice-note.ogg').
      const mime = normalizeMime(item.mimeType);
      const filename = attachmentFilename(
        item.mediaKind,
        item.filename,
        item.mimeType,
      );
      const ext = extOf(filename) ?? extFromMime(item.mimeType);
      const metadata: Record<string, unknown> = {
        chat_key: item.chatJid,
        sizeBytes: item.bytes.byteLength,
      };
      if (mime !== undefined) metadata.mime = mime;
      if (filename !== undefined) metadata.filename = filename;
      if (ext !== undefined) metadata.ext = ext;
      if (item.mediaRef) metadata.wa_msg = item.mediaRef;
      return {
        externalId: `${item.chatJid}:${item.msgId}`,
        type: FILE_DOC_TYPE,
        title: filename ?? 'attachment',
        // null markdown + binary bytes: the ENGINE converts (parsers/OCR).
        markdown: null,
        binary: {
          bytes: item.bytes,
          mime: mime ?? 'application/octet-stream',
          ...(filename !== undefined ? { filename } : {}),
        },
        metadata,
        createdAt: new Date(item.sentAtMs).toISOString(),
        parent: { externalId: `${item.chatJid}:${item.day}`, type: DOC_TYPE },
      };
    },

    /**
     * Deep-extraction byte path: the platform's vision (OCR/VLM) and audio
     * (transcription) workers re-fetch a file doc's bytes on demand — the
     * store never keeps binary. The wa_msg ref rebuilds the exact message
     * (mediaKey, directPath, url) for a fresh CDN download/decrypt. Null on
     * any failure: the worker records a terminal 'skip' for that doc and the
     * walk continues. WhatsApp media does expire upstream, so an old ref
     * yielding null is expected, not exceptional.
     */
    async fetchBytes(
      session: Session,
      doc: Document,
    ): Promise<Uint8Array | null> {
      const ref = (doc.metadata as { wa_msg?: unknown }).wa_msg;
      if (typeof ref !== 'string' || ref.length === 0) return null;
      const wm = decodeMediaRef(ref);
      if (!wm) {
        session.log(
          'warn',
          `whatsapp: unreadable wa_msg ref on ${doc.externalId} — cannot re-fetch media`,
        );
        return null;
      }
      const bytes = await downloadMedia(wm, session.signal);
      if (!bytes || bytes.length > MEDIA_SIZE_CAP_BYTES) return null;
      return bytes;
    },
  };
}
