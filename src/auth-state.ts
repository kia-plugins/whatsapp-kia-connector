import fs from 'node:fs';
import path from 'node:path';
import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

/**
 * Encryption seam for the on-disk auth blob.
 *
 * SECURITY REGRESSION vs v1 (documented in README): v1 encrypted this blob
 * with Electron safeStorage; the v2 extension host exposes no keychain
 * surface, so the DEFAULT codec is plaintext (0600, atomic). When the
 * platform grows a vault/keychain capability, an encrypting codec slots in
 * here without touching the state machinery.
 */
export interface AuthBlobCodec {
  encode(plain: string): Buffer;
  decode(stored: Buffer): string;
}

export const plaintextCodec: AuthBlobCodec = {
  encode: (plain) => Buffer.from(plain, 'utf8'),
  decode: (stored) => stored.toString('utf8'),
};

// The signal key store is heterogeneous (pre-keys, sessions, sender-keys,
// app-state-sync-keys, …). We keep it loosely typed in storage and rely on
// Baileys' BufferJSON reviver/replacer for binary fidelity; `state.keys`
// below still satisfies Baileys' fully-typed SignalKeyStore contract.
interface Persisted {
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

function writeBlob(filePath: string, data: Persisted, codec: AuthBlobCodec): void {
  const plain = JSON.stringify(data, BufferJSON.replacer);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Write to a temp sibling then rename: a crash mid-write must never leave a
  // partial blob in place of the real one. Rename within the same dir is
  // atomic on local filesystems.
  const tmpPath = `${filePath}.part`;
  fs.writeFileSync(tmpPath, codec.encode(plain), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/** Baileys AuthenticationState over one in-memory {creds, keys} store;
 *  every keys.set mutation calls `persist`. */
function buildState(data: Persisted, persist: () => Promise<void>): AuthenticationState {
  return {
    creds: data.creds,
    keys: {
      get: (type, ids) => {
        const out: Record<string, unknown> = {};
        const bucket = data.keys[type] ?? {};
        for (const id of ids) {
          let value = bucket[id];
          if (value === undefined) continue;
          // Mirror Baileys' useMultiFileAuthState: app-state-sync-key values
          // must be re-wrapped in their proto message so downstream consumers
          // get the typed accessors, not the raw revived object.
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          out[id] = value;
        }
        return out as never;
      },
      set: (mod) => {
        for (const type of Object.keys(mod) as (keyof SignalDataTypeMap)[]) {
          const incoming = mod[type] as Record<string, unknown>;
          data.keys[type] ??= {};
          const bucket = data.keys[type];
          for (const id of Object.keys(incoming)) {
            const value = incoming[id];
            // Baileys signals deletion of a key with a null value.
            if (value === null || value === undefined) delete bucket[id];
            else bucket[id] = value;
          }
        }
        return persist();
      },
    },
  };
}

export interface LoadedAuthState {
  state: AuthenticationState;
  /** Persist the whole blob (Baileys calls this on every creds change). */
  saveCreds: () => Promise<void>;
}

export interface FreshAuthState {
  state: AuthenticationState;
  /** Persist the current {creds, keys} snapshot to `filePath` (atomic, 0600).
   *  Pairing calls this ONCE, after the connection opens — no half-paired
   *  blob ever lands on disk. */
  save: (filePath: string, codec?: AuthBlobCodec) => Promise<void>;
}

/** Brand-new unregistered creds, held in memory until save() — the connect()
 *  pairing flow. Key mutations during pairing stay in memory too. */
export function makeFreshAuthState(): FreshAuthState {
  const data: Persisted = { creds: initAuthCreds(), keys: {} };
  return {
    state: buildState(data, async () => {}),
    save: async (filePath, codec = plaintextCodec) => writeBlob(filePath, data, codec),
  };
}

/**
 * Load a previously-paired auth blob. Returns null when the account cannot be
 * resumed — no file yet, or an unreadable/corrupt blob. A corrupt blob is NOT
 * silently wiped (the next saveCreds would overwrite a possibly-recoverable
 * session): it is moved aside to `<file>.corrupt` for diagnostics, and the
 * caller tells the user to re-pair.
 */
export function loadAuthState(
  filePath: string,
  opts?: { codec?: AuthBlobCodec; warn?: (msg: string) => void },
): LoadedAuthState | null {
  const codec = opts?.codec ?? plaintextCodec;
  let data: Persisted;
  try {
    const plain = codec.decode(fs.readFileSync(filePath));
    data = JSON.parse(plain, BufferJSON.reviver) as Persisted;
    if (!data || typeof data !== 'object' || !data.creds) {
      throw new Error('auth blob has no creds');
    }
    data.keys ??= {};
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') return null;
    opts?.warn?.(
      `whatsapp: auth blob unreadable (${code ?? (err as Error)?.message}) — quarantined as .corrupt; re-pair required`,
    );
    try {
      fs.renameSync(filePath, `${filePath}.corrupt`);
    } catch {
      /* best-effort */
    }
    return null;
  }
  const persist = async (): Promise<void> => writeBlob(filePath, data, codec);
  return { state: buildState(data, persist), saveCreds: persist };
}
