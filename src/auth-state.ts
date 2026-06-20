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
import type { SafeStorageLike } from '@alpha-cent/connector-sdk';

// The signal key store is heterogeneous (pre-keys, sessions, sender-keys,
// app-state-sync-keys, …). We keep it loosely typed in storage and rely on
// Baileys' BufferJSON reviver/replacer for binary fidelity; `state.keys` below
// still satisfies Baileys' fully-typed SignalKeyStore contract.
interface Persisted {
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

/**
 * One encrypted blob holding Baileys creds + signal keys. saveCreds is called
 * by Baileys on every key change; we serialize the whole store (small for a
 * single linked device) via BufferJSON and encrypt with safeStorage.
 *
 * Baileys' bundled `useMultiFileAuthState` is demo-only (one plaintext file per
 * key); we keep everything in a single encrypted file instead.
 */
export async function makeEncryptedAuthState(
  filePath: string,
  ss: SafeStorageLike,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  let data: Persisted;
  try {
    const plain = ss.decryptString(fs.readFileSync(filePath));
    data = JSON.parse(plain, BufferJSON.reviver) as Persisted;
  } catch (err) {
    // Distinguish "no file yet" (expected first run) from "file exists but
    // failed to decrypt/parse" (safeStorage key changed / corrupt write). The
    // latter must NOT be silently wiped: the next saveCreds would overwrite the
    // still-present blob and permanently destroy a possibly-recoverable session.
    const code = (err as { code?: string })?.code;
    if (code !== 'ENOENT') {
      console.warn(
        `[whatsapp] auth-state unreadable (${
          code ?? (err as Error)?.message
        }); starting fresh — re-pair required`,
      );
      // Best-effort: move the unreadable blob aside so saveCreds can't clobber
      // the file, and so it survives for diagnostics / manual recovery.
      try {
        fs.renameSync(filePath, `${filePath}.corrupt`);
      } catch {
        /* best-effort */
      }
    }
    data = { creds: initAuthCreds(), keys: {} };
  }

  const persist = async (): Promise<void> => {
    // Refuse to write near-plaintext credentials on a keyring-less platform.
    if (!ss.isEncryptionAvailable()) {
      throw new Error(
        'safeStorage encryption unavailable; refusing to write WhatsApp credentials unencrypted',
      );
    }
    const plain = JSON.stringify(data, BufferJSON.replacer);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Write to a temp sibling then rename: a crash mid-write must never leave a
    // partially-encrypted blob in place of the real one. Rename within the same
    // dir is atomic on local filesystems (mirrors media.ts / deep-extraction).
    const tmpPath = `${filePath}.part`;
    fs.writeFileSync(tmpPath, ss.encryptString(plain), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  };

  const state: AuthenticationState = {
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

  return { state, saveCreds: persist };
}
