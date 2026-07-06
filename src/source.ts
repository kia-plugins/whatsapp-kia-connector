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

import {
  loadAuthState,
  makeFreshAuthState,
  plaintextCodec,
  type AuthBlobCodec,
} from './auth-state';
import { DOC_TYPE, dayTitle, renderDay } from './chat-day';
import { normalizeJid } from './contacts';
import type {
  AuthChannel,
  Batch,
  DocumentInput,
  HostFor,
  Session,
  Source,
} from './kiagent-contracts';
import { defaultDownloadMedia, FILE_DOC_TYPE } from './media';
import { pairAndWaitOpen } from './pair';
import { WhatsAppPullRuntime } from './runtime';
import type { NormalizedMessage, WhatsAppCursor, WhatsAppItem } from './types';

export type WhatsAppHost = HostFor<'net' | 'query'>;

/** Test seams — production callers omit all of these. */
export interface WhatsAppSourceSeams {
  /** Socket factory factory: resolves Baileys version, returns the per-
   *  (re)connect socket maker. Tests return a fake-socket maker. */
  makeSocketFactory?: (auth: AuthenticationState) => Promise<() => WASocket>;
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

/**
 * Best-effort protocol version: fetchLatestBaileysVersion raced against 3s —
 * on timeout/failure Baileys falls back to its baked-in default (v1 parity).
 */
async function defaultSocketFactory(
  auth: AuthenticationState,
): Promise<() => WASocket> {
  const version = await Promise.race([
    fetchLatestBaileysVersion()
      .then((r) => r.version)
      .catch(() => undefined),
    new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), 3000);
      t.unref?.();
    }),
  ]);
  return () =>
    makeWASocket({
      version,
      auth,
      browser: PAIRING_BROWSER,
      syncFullHistory: true,
    });
}

/** '4917012345@s.whatsapp.net' → a safe blob filename stem. */
function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

const NOT_PAIRED = 'whatsapp: not paired — reconnect the account';

export function createWhatsAppSource(
  host: WhatsAppHost,
  seams: WhatsAppSourceSeams = {},
): Source<WhatsAppCursor, WhatsAppItem> {
  const makeSocketFactory = seams.makeSocketFactory ?? defaultSocketFactory;
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
        throw new Error(NOT_PAIRED);
      }
      const loaded = loadAuthState(path.join(host.self.dataDir, authFile), {
        codec,
        warn: (msg) => session.log('warn', msg),
      });
      if (!loaded) throw new Error(NOT_PAIRED);

      const selfJid = normalizeJid(
        loaded.state.creds.me?.id ?? 'unknown@s.whatsapp.net',
      );
      const makeSocket = await makeSocketFactory(loaded.state);
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
        // Auth error propagates (engine records lastError); shaped so
        // isAuthError()-style checks recognize it.
        const err = new Error(
          'whatsapp: logged out (401 unauthenticated) — reconnect the account',
        ) as Error & { status: number };
        err.status = 401;
        throw err;
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
            chat_jid: chat.jid,
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
      const metadata: Record<string, unknown> = {
        chat_key: item.chatJid,
        size_bytes: item.bytes.byteLength,
      };
      if (item.mimeType !== undefined) metadata.mime_type = item.mimeType;
      if (item.filename !== undefined) metadata.filename = item.filename;
      return {
        externalId: `${item.chatJid}:${item.msgId}`,
        type: FILE_DOC_TYPE,
        title: item.filename ?? 'attachment',
        // null markdown + binary bytes: the ENGINE converts (parsers/OCR).
        markdown: null,
        binary: {
          bytes: item.bytes,
          mime: item.mimeType ?? 'application/octet-stream',
          ...(item.filename !== undefined ? { filename: item.filename } : {}),
        },
        metadata,
        createdAt: new Date(item.sentAtMs).toISOString(),
        parent: { externalId: `${item.chatJid}:${item.day}`, type: DOC_TYPE },
      };
    },
  };
}
