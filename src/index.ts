import makeWASocket, {
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import type {
  Account,
  Connector,
  ConnectorInstance,
  ConnectorHost,
  ConnectorSetupHost,
} from '@kiagent/connector-sdk';
import type { Db, Converter } from './host';
import { makeEncryptedAuthState } from './auth-state';
import { WhatsAppRuntime } from './instance';
import { mediaDir } from './media-dir';
import { makeWhatsappByteSource } from './byte-source';
import { beginWhatsAppPairing, cancelWhatsAppPairing } from './pairing';
import { importChatFile } from './import-file';

export const connector: Connector = {
  id: 'whatsapp',
  displayName: 'WhatsApp',
  capabilities: {
    multiAccount: true,
    requiresAuth: true,
    supportsBackfill: true,
    supportsDelta: true,
    supportsRealtime: true,
  },
  getAccountSchema: () => ({ type: 'object', properties: {} }),
  validateAccount: () => ({ ok: true }),
  createInstance,
};

async function createInstance(account: Account, ctx: ConnectorHost): Promise<ConnectorInstance> {
  const credsPath = account.credentials_blob_path!;
  const auth = await makeEncryptedAuthState(credsPath, ctx.safeStorage);

  const version = await Promise.race([
    fetchLatestBaileysVersion().then((r) => r.version).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
  ]);

  const makeSocket = () =>
    makeWASocket({
      version,
      auth: auth.state,
      browser: Browsers.appropriate('Desktop'),
      syncFullHistory: true,
    });

  const selfJid = auth.state.creds.me?.id ?? 'unknown@s.whatsapp.net';
  const runtime = new WhatsAppRuntime({
    ctx,
    accountId: account.id,
    selfJid,
    mediaDir: mediaDir(ctx.dataDir),
    makeSocket,
    downloadMedia: async (wm) => {
      try {
        const buf = await downloadMediaMessage(wm, 'buffer', {});
        return Buffer.isBuffer(buf) ? buf : null;
      } catch {
        return null;
      }
    },
    onQr: (qr) =>
      ctx.emitStreamEvent({ connectorId: 'whatsapp', accountId: String(account.id), qr }),
    onConnected: () => {
      void auth.saveCreds();
      const { me } = auth.state.creds;
      if (me?.id) {
        const phone = me.id.split(':')[0].split('@')[0];
        void (ctx.db as Db)
          .run(`UPDATE accounts SET identifier=?, display_name=? WHERE id=?`, [me.id, me.name ?? phone, account.id])
          .catch((e) => console.warn('[whatsapp] account promotion (re-pair?) failed:', e));
      }
      ctx.emitStreamEvent({ connectorId: 'whatsapp', accountId: String(account.id), status: 'connected' });
    },
    onCredsUpdate: () => void auth.saveCreds(),
  });

  return {
    async startBackfill(progress) {
      await runtime.startBackfill();
      progress.update(1, 1);
    },
    async startRealtime() {
      await runtime.startRealtime();
    },
    async pollDelta() {
      await runtime.pollDelta();
    },
    requestStop() {
      void runtime.shutdown();
    },
    async shutdown() {
      await runtime.shutdown();
    },
    buildSourceUrl: (_id, _type, metadata) =>
      metadata.chat_jid ? `whatsapp://chat?jid=${encodeURIComponent(String(metadata.chat_jid))}` : '',
  };
}

/** Find-or-create the single import-backed whatsapp account ('imports'). */
async function ensureWhatsAppAccount(db: Db): Promise<bigint> {
  const existing = await db.all(`SELECT id FROM accounts WHERE source='whatsapp' AND identifier='imports'`);
  if (existing[0]) return existing[0].id as bigint;
  const r = await db.all(
    `INSERT INTO accounts (source, identifier, display_name, enabled)
     VALUES ('whatsapp', 'imports', 'WhatsApp (imported chats)', 0) RETURNING id`,
  );
  const accountId = r[0].id as bigint;
  await db.run(`INSERT INTO sync_state (account_id, status) VALUES (?, 'live')`, [accountId]);
  return accountId;
}

/** The 'whatsapp-import' action hook: pick a chat export, ingest it. */
async function whatsappImport(
  _payload: Record<string, unknown> | undefined,
  ctx: ConnectorSetupHost,
): Promise<{ ok: boolean; message?: string; error?: string; days?: number; messages?: number }> {
  const picked = await ctx.pickFile({
    title: 'Import WhatsApp chat export',
    properties: ['openFile'],
    filters: [{ name: 'WhatsApp export', extensions: ['zip', 'txt'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'cancelled' };
  try {
    const db = ctx.db as Db;
    const accountId = await ensureWhatsAppAccount(db);
    const host = ctx.hostFor(accountId);
    const r = await importChatFile({
      ctx: host,
      accountId,
      baseDir: mediaDir(host.dataDir),
      converter: host.converter as Converter,
      filePath: picked.filePaths[0],
    });
    await ctx.publishState();
    if (r.ok) {
      const days = r.days ?? 0;
      return {
        ok: true,
        days,
        messages: r.messages,
        message: `Imported ${(r.messages ?? 0).toLocaleString()} messages across ${days.toLocaleString()} ${days === 1 ? 'day' : 'days'}.`,
      };
    }
    return { ok: false, error: r.error ?? 'Import failed.', message: r.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const hooks = {
  'begin-pairing': beginWhatsAppPairing,
  'cancel-pairing': cancelWhatsAppPairing,
  'whatsapp-import': whatsappImport,
};

export function makeByteSource(deps: { dataDir: string }) {
  return makeWhatsappByteSource(deps.dataDir);
}

export default { connector, hooks, makeByteSource };
module.exports = { connector, hooks, makeByteSource };
