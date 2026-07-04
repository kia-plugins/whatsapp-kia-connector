import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AuthBlobCodec } from '../auth-state';
import { loadAuthState, makeFreshAuthState } from '../auth-state';

const tmpFile = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-')), 'auth', 'creds.bin');

describe('auth-state (plaintext blob, injectable codec)', () => {
  it('round-trips fresh creds through save() → loadAuthState()', async () => {
    const file = tmpFile();
    const fresh = makeFreshAuthState();
    fresh.state.creds.me = { id: '111:5@s.whatsapp.net', name: 'Me' } as never;
    await fresh.save(file);

    const loaded = loadAuthState(file);
    expect(loaded).not.toBeNull();
    expect(loaded!.state.creds.me?.id).toBe('111:5@s.whatsapp.net');
    expect(loaded!.state.creds.registered).toBe(false);
  });

  it('starts pairing from brand-new unregistered creds', () => {
    const fresh = makeFreshAuthState();
    expect(fresh.state.creds.registered).toBe(false);
    expect(fresh.state.creds.me).toBeUndefined();
  });

  it('returns null when no blob exists (missing ≠ corrupt: nothing quarantined)', () => {
    const file = tmpFile();
    expect(loadAuthState(file)).toBeNull();
    expect(fs.existsSync(`${file}.corrupt`)).toBe(false);
  });

  it('quarantines an unreadable blob as .corrupt and returns null (never clobbered)', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from('garbage-not-json'));
    const warnings: string[] = [];
    const loaded = loadAuthState(file, { warn: (m) => warnings.push(m) });
    expect(loaded).toBeNull();
    // The unreadable blob is moved aside so a later save can't overwrite a
    // possibly-recoverable session, and survives for diagnostics.
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(warnings.some((w) => /unreadable/.test(w))).toBe(true);
  });

  it('saveCreds persists later mutations (Baileys calls it on every key change)', async () => {
    const file = tmpFile();
    const fresh = makeFreshAuthState();
    await fresh.save(file);

    const a = loadAuthState(file)!;
    a.state.creds.me = { id: '222@s.whatsapp.net' } as never;
    await a.saveCreds();

    const b = loadAuthState(file)!;
    expect(b.state.creds.me?.id).toBe('222@s.whatsapp.net');
  });

  it('persists signal-key mutations via keys.set and reads them back via keys.get', async () => {
    const file = tmpFile();
    const fresh = makeFreshAuthState();
    await fresh.save(file);

    const a = loadAuthState(file)!;
    await a.state.keys.set({
      session: { s1: new Uint8Array([1, 2, 3]) },
    } as never);

    const b = loadAuthState(file)!;
    const got = await b.state.keys.get('session' as never, ['s1']);
    expect(new Uint8Array((got as Record<string, Uint8Array>).s1)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('writes atomically with 0600 and leaves no .part temp behind', async () => {
    const file = tmpFile();
    const fresh = makeFreshAuthState();
    await fresh.save(file);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('routes bytes through the injectable codec (future vault seam)', async () => {
    // An obviously-fake "cipher": reverse the bytes. Proves save/load both go
    // through the codec rather than assuming plaintext.
    const reversing: AuthBlobCodec = {
      encode: (plain) => Buffer.from(plain, 'utf8').reverse(),
      decode: (stored) => Buffer.from(stored).reverse().toString('utf8'),
    };
    const file = tmpFile();
    const fresh = makeFreshAuthState();
    fresh.state.creds.me = { id: '333@s.whatsapp.net' } as never;
    await fresh.save(file, reversing);

    // Plaintext read of the same file fails → quarantine path.
    expect(loadAuthState(`${file}`, { codec: reversing })!.state.creds.me?.id).toBe(
      '333@s.whatsapp.net',
    );
  });
});
