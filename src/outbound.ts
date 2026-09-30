/**
 * Reply support for WhatsApp chat-day documents.
 *
 * `outboundFor` is what toDocument stores under `metadata.outbound` so
 * kiagent-core's `draft_reply` can address a reply to the chat a day doc
 * belongs to — the model picks the document, never a jid. Chat level only:
 * quoting one message would need the full WebMessageInfo, which the ledger
 * does not keep.
 *
 * `migrationItems` is the one-time backfill: day docs stored before reply
 * support carry no target, and WhatsApp may replay no history on a resumed
 * session, so pull() re-emits them from the store itself — the newest day of
 * every chat plus everything from the last `MIGRATION_WINDOW_DAYS`.
 */
import type { AccountId, HostFor } from '@kiagent/connector-sdk';

import { DOC_TYPE } from './chat-day';
import type { ChatInfo, DayItem, NormalizedMessage } from './types';

export const MIGRATION_WINDOW_DAYS = 30;
const PAGE = 200;

/** Chats a message can be sent to: people (phone or LID jids) and groups —
 *  never status broadcasts, broadcast lists or channels. */
export function isReplyableJid(jid: string): boolean {
  return /@(s\.whatsapp\.net|lid|g\.us)$/.test(jid);
}

export function outboundFor(chat: ChatInfo): Record<string, unknown> | undefined {
  if (!isReplyableJid(chat.jid)) return undefined;
  return { ref: { jid: chat.jid }, display: chat.name };
}

/** The stored ref as the Sender receives it — re-validated. */
export function parseOutboundRef(v: unknown): { jid: string } | null {
  const jid = (v as { jid?: unknown } | null | undefined)?.jid;
  return typeof jid === 'string' && isReplyableJid(jid) ? { jid } : null;
}

/** Rebuild a day item from a stored day doc, or null when it is not one
 *  this connector wrote (or already carries a reply target). */
function storedDayItem(doc: {
  externalId: string;
  title: string | null;
  metadata: Record<string, unknown>;
}): DayItem | null {
  const m = doc.metadata;
  if (m.outbound !== undefined) return null;
  const jid = m.chat_key;
  const messages = m.messages;
  const sep = doc.externalId.lastIndexOf(':');
  if (typeof jid !== 'string' || !Array.isArray(messages) || sep < 0) return null;
  const day = doc.externalId.slice(sep + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  // The title is dayTitle(name, day) = '<name> — Mon D, YYYY'; the stored
  // chat_name (written since reply support) wins when present.
  const title = doc.title ?? '';
  const cut = title.lastIndexOf(' — ');
  const name =
    typeof m.chat_name === 'string' ? m.chat_name : cut > 0 ? title.slice(0, cut) : jid;
  return {
    kind: 'day',
    chat: { jid, name, type: m.chat_type === 'group' ? 'group' : 'dm' },
    day,
    messages: messages as NormalizedMessage[],
  };
}

/** Pages the account's stored day docs newest-first and yields, in chunks,
 *  the ones to re-emit: the newest day of every chat, and every day newer
 *  than the window. */
export async function* migrationItems(
  host: HostFor<'query'>,
  account: AccountId,
  nowMs: number,
): AsyncGenerator<DayItem[]> {
  const since = new Date(nowMs - MIGRATION_WINDOW_DAYS * 86_400_000).toISOString();
  const seenChats = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await host.query.search({
      type: DOC_TYPE,
      account,
      orderBy: 'newest',
      limit: PAGE,
      offset,
    });
    const chunk: DayItem[] = [];
    for (const doc of page) {
      const jid = (doc.metadata as { chat_key?: unknown }).chat_key;
      const newestOfChat = typeof jid === 'string' && !seenChats.has(jid);
      if (typeof jid === 'string') seenChats.add(jid);
      const recent = (doc.createdAt ?? '') >= since;
      if (!newestOfChat && !recent) continue;
      const item = storedDayItem(doc);
      if (item) chunk.push(item);
    }
    if (chunk.length) yield chunk;
    if (page.length < PAGE) return;
  }
}
