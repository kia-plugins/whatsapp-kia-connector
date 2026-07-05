import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AuthenticationState, WASocket } from '@whiskeysockets/baileys';

import { loadAuthState } from '../auth-state';
import type { AuthChannel, HostFor } from '../kiagent-contracts';
import { createWhatsAppSource, PAIRING_BROWSER } from '../source';

/**
 * Fake Baileys factory mirroring real behavior: a FRESH emitter per call
 * (the restart-after-pair path makes a second socket). Exposes the latest
 * emitter so the test drives `connection.update` on it.
 */
function countingBaileys() {
  const state = {
    calls: 0,
    ev: undefined as EventEmitter | undefined,
    ended: 0,
  };
  const factory = (): WASocket => {
    state.calls += 1;
    const ev = new EventEmitter();
    state.ev = ev;
    return {
      ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) },
      end: () => {
        state.ended += 1;
      },
      ws: { close: jest.fn() },
    } as unknown as WASocket;
  };
  return { state, factory };
}

function makeHost(dataDir: string): HostFor<'net' | 'query'> {
  return {
    self: { id: 'kia.whatsapp', dataDir },
    log: () => {},
    net: {
      fetch: async () => {
        throw new Error('whatsapp source must not use host.net.fetch');
      },
    },
    query: {
      byExternalId: async () => null,
    } as unknown as HostFor<'net' | 'query'>['query'],
  };
}

function makeAuth() {
  const qrs: string[] = [];
  const statuses: string[] = [];
  const auth: AuthChannel = {
    oauth: async () => ({}),
    showQr: (qr) => qrs.push(qr),
    prompt: async () => ({}),
    status: (msg) => statuses.push(msg),
  };
  return { auth, qrs, statuses };
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition not met in time');
}

function makeSource(
  dataDir: string,
  factory: () => WASocket,
  onState?: (s: AuthenticationState) => void,
  pairingTimeoutMs?: number,
) {
  return createWhatsAppSource(makeHost(dataDir), {
    makeSocketFactory: async (state) => {
      onState?.(state);
      return factory;
    },
    pairingTimeoutMs,
  });
}

describe('connect (QR pairing)', () => {
  const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-connect-'));

  it('pushes every rotating QR to showQr, and on open persists the blob and returns the normalized identifier', async () => {
    const dir = dataDir();
    const { state, factory } = countingBaileys();
    let pairingState: AuthenticationState | undefined;
    const source = makeSource(dir, factory, (s) => {
      pairingState = s;
    });
    const { auth, qrs, statuses } = makeAuth();

    const pending = source.connect(auth);
    await waitFor(() => state.calls === 1);
    state.ev!.emit('connection.update', { qr: 'QR-ONE' });
    state.ev!.emit('connection.update', { qr: 'QR-TWO' }); // QR rotated
    // The phone scanned: Baileys fills creds.me, then the connection opens.
    pairingState!.creds.me = { id: '4917012345:7@s.whatsapp.net', name: 'Me' } as never;
    state.ev!.emit('connection.update', { connection: 'open' });

    const result = await pending;
    expect(qrs).toEqual(['QR-ONE', 'QR-TWO']);
    expect(statuses.some((s) => /Linked Devices/.test(s))).toBe(true);
    // Identifier is the bare phone-user JID (device suffix stripped)…
    expect(result.identifier).toBe('4917012345@s.whatsapp.net');
    // …and the connector-managed auth blob is persisted under dataDir.
    expect(result.config).toEqual({
      authFile: 'auth/4917012345_s.whatsapp.net.bin',
    });
    const blobPath = path.join(dir, 'auth/4917012345_s.whatsapp.net.bin');
    expect(fs.existsSync(blobPath)).toBe(true);
    const loaded = loadAuthState(blobPath);
    expect(loaded!.state.creds.me?.id).toBe('4917012345:7@s.whatsapp.net');
    // The pairing socket was closed cleanly.
    expect(state.ended).toBeGreaterThanOrEqual(1);
  });

  it('survives the restart-after-pair close (restartRequired opens a fresh socket)', async () => {
    const dir = dataDir();
    const { state, factory } = countingBaileys();
    let pairingState: AuthenticationState | undefined;
    const source = makeSource(dir, factory, (s) => {
      pairingState = s;
    });
    const { auth } = makeAuth();

    const pending = source.connect(auth);
    await waitFor(() => state.calls === 1);
    pairingState!.creds.me = { id: '111:1@s.whatsapp.net' } as never;
    // QR accepted → server forces a restart (515). NOT a failure.
    state.ev!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await waitFor(() => state.calls === 2); // fresh socket, registered creds
    state.ev!.emit('connection.update', { connection: 'open' });

    const result = await pending;
    expect(result.identifier).toBe('111@s.whatsapp.net');
  });

  it('throws with the disconnect reason on a close before open', async () => {
    const dir = dataDir();
    const { state, factory } = countingBaileys();
    const source = makeSource(dir, factory);
    const { auth } = makeAuth();

    const pending = source.connect(auth);
    await waitFor(() => state.calls === 1);
    const boom = Object.assign(new Error('Connection Failure'), {
      output: { statusCode: 401 },
    });
    state.ev!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: boom },
    });

    await expect(pending).rejects.toThrow(/pairing failed: Connection Failure/);
    // Nothing half-paired lands on disk.
    expect(fs.existsSync(path.join(dir, 'auth'))).toBe(false);
  });

  it('throws "pairing timed out" when nobody scans before the deadline', async () => {
    const dir = dataDir();
    const { factory } = countingBaileys();
    const source = makeSource(dir, factory, undefined, 30 /* ms */);
    const { auth } = makeAuth();

    await expect(source.connect(auth)).rejects.toThrow(/timed out — try again/);
  });

  it('never advertises a Desktop sub-platform identity to WhatsApp', () => {
    // WhatsApp closes registration with 428 "Connection Terminated" before
    // any QR when the client claims DARWIN/WIN32 (Baileys OS names 'Mac OS'/
    // 'Windows') or the 'Desktop' browser — WhiskeySockets/Baileys#2677.
    const [osName, browserName] = PAIRING_BROWSER;
    expect(['Mac OS', 'Windows']).not.toContain(osName);
    expect(browserName).not.toBe('Desktop');
  });
});
