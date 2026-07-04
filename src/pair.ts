import { DisconnectReason } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';

import { statusCodeOf } from './socket';

export const PAIRING_TIMEOUT_MS = 180_000;

export interface PairDeps {
  /** MUST return a FRESH socket per call (the restart-after-pair path). */
  makeSocket: () => WASocket;
  onQr: (qr: string) => void;
  /** Overall pairing deadline. Default 180s (~three QR rotation cycles). */
  timeoutMs?: number;
}

/**
 * Drive one pairing attempt to a successful 'open'. Baileys' QR flow:
 * the socket emits rotating `qr` payloads (each pushed to the wizard via
 * onQr); when the phone scans one, the server accepts the device and CLOSES
 * the socket with DisconnectReason.restartRequired — the one close that means
 * success-so-far, so we silently reopen with the now-registered creds and
 * wait for 'open'. Any other close before 'open' (401 loggedOut, QR timeout,
 * bad session) rejects with the disconnect reason; the overall deadline
 * rejects with 'pairing timed out'.
 */
export function pairAndWaitOpen(deps: PairDeps): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sock: WASocket | undefined;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.end(undefined);
      } catch {
        /* ignore — socket may already be torn down */
      }
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('whatsapp pairing timed out — try again'))),
      deps.timeoutMs ?? PAIRING_TIMEOUT_MS,
    );
    timer.unref?.();
    const open = (): void => {
      sock = deps.makeSocket();
      sock.ev.on('connection.update', (u) => {
        if (u.qr) deps.onQr(u.qr);
        if (u.connection === 'open') finish(resolve);
        if (u.connection === 'close') {
          const code = statusCodeOf(u.lastDisconnect?.error);
          if (code === DisconnectReason.restartRequired) {
            if (!settled) open();
            return;
          }
          const err = u.lastDisconnect?.error;
          const reason =
            err instanceof Error && err.message
              ? err.message
              : `connection closed (${code ?? 'unknown'})`;
          finish(() => reject(new Error(`whatsapp pairing failed: ${reason}`)));
        }
      });
    };
    open();
  });
}
