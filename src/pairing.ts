import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { ConnectorSetupHost } from '@kiagent/connector-sdk';
import type { Db } from './host';

type AddResult =
  | { ok: true; accountId?: string; [k: string]: unknown }
  | { ok: false; error?: string; message?: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function beginWhatsAppPairing(
  _payload: Record<string, unknown> | undefined,
  ctx: ConnectorSetupHost,
): Promise<AddResult> {
  if (!ctx.safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'vault-failed', message: 'safeStorage encryption unavailable' };
  }
  fs.mkdirSync(ctx.oauthDir, { recursive: true });
  const credsPath = path.join(ctx.oauthDir, `${crypto.randomUUID()}.bin`);
  const db = ctx.db as Db;
  let accountId: bigint;
  try {
    const ident = `pending-${crypto.randomUUID()}`;
    const r = await db.all(
      `INSERT INTO accounts (source, identifier, display_name, credentials_blob_path)
         VALUES ('whatsapp', ?, 'WhatsApp', ?) RETURNING id`,
      [ident, credsPath],
    );
    accountId = r[0].id as bigint;
    await db.run(`INSERT INTO sync_state (account_id, status) VALUES (?, 'pending')`, [accountId]);
  } catch (e) {
    return { ok: false, error: 'db-failed', message: errMsg(e) };
  }
  try {
    await ctx.restartAccount(accountId);
  } catch (e) {
    console.error('[whatsapp] pairing restartAccount failed', e);
  }
  try {
    await ctx.publishState();
  } catch {
    /* best-effort */
  }
  return { ok: true, accountId: String(accountId) };
}

export async function cancelWhatsAppPairing(
  payload: { accountId?: string } | undefined,
  ctx: ConnectorSetupHost,
): Promise<{ ok: boolean; error?: string }> {
  const idStr = payload?.accountId;
  if (!idStr) return { ok: false, error: 'no accountId' };
  const accountId = BigInt(idStr);
  const db = ctx.db as Db;
  try {
    const rows = await db.all(
      `SELECT identifier, credentials_blob_path AS p FROM accounts WHERE id=? AND source='whatsapp'`,
      [accountId],
    );
    const row = rows[0];
    if (!row || !String(row.identifier).startsWith('pending-')) return { ok: true };
    try {
      await ctx.removeAccount(accountId);
    } catch (e) {
      console.error('[whatsapp] cancel removeAccount', e);
    }
    await db.run(`DELETE FROM sync_state WHERE account_id=?`, [accountId]);
    await db.run(`DELETE FROM accounts WHERE id=?`, [accountId]);
    try {
      if (row.p) fs.rmSync(String(row.p), { force: true });
    } catch {
      /* best-effort */
    }
    await ctx.publishState();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
