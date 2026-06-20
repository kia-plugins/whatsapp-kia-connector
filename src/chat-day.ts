// src/main/connectors/whatsapp/chat-day.ts
import crypto from 'node:crypto';
import type { Host } from './host';
import type { ChatRef, MediaDescriptor, NormalizedMessage } from './types';

export const DOC_TYPE = 'whatsapp_chat_day';

/** Local-calendar day key 'YYYY-MM-DD' for an epoch-ms timestamp. */
export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Union of existing + incoming messages, deduped by id, ascending by ts. */
export function mergeMessages(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  const byId = new Map<string, NormalizedMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m); // incoming wins on conflict
  return [...byId.values()].sort(
    (a, b) => a.tsMs - b.tsMs || a.id.localeCompare(b.id),
  );
}

function hhmm(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

function mediaLabel(media: MediaDescriptor): string {
  if (media.kind === 'audio' && media.durationSec) {
    const mm = Math.floor(media.durationSec / 60);
    const ss = String(Math.floor(media.durationSec % 60)).padStart(2, '0');
    return `[voice note ${mm}:${ss}]`;
  }
  if (media.kind === 'document')
    return `[document: ${media.filename ?? 'file'}]`;
  return `[${media.kind}]`;
}

/** Render the day's messages to markdown. attachmentDocId maps message id → doc id. */
export function renderDay(
  chatName: string,
  messages: NormalizedMessage[],
  attachmentDocId: (msgId: string) => string | undefined = () => undefined,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.system) {
      lines.push(`_${m.text}_`);
      continue;
    }
    const parts: string[] = [`${hhmm(m.tsMs)} ${m.sender ?? '?'}:`];
    if (m.quote) parts.push(`↳re ${m.quote.sender ?? '?'}: ${m.quote.snippet}`);
    if (m.media) {
      const docId = attachmentDocId(m.id);
      parts.push(
        docId
          ? `${mediaLabel(m.media)} [Attachment](doc://${docId})`
          : mediaLabel(m.media),
      );
    }
    if (m.text) parts.push(m.text);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
function dayTitle(chatName: string, key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${chatName} — ${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Group `messages` by local day and upsert one whatsapp_chat_day doc per day,
 * merging into any existing doc. `attachmentDocId` lets the media path link
 * already-ingested file docs; pass a no-op when there are no attachments.
 */
export async function upsertChatDays(args: {
  ctx: Host;
  accountId: bigint;
  chat: ChatRef;
  messages: NormalizedMessage[];
  attachmentDocId?: (msgId: string) => string | undefined;
}): Promise<void> {
  const { ctx, accountId, chat } = args;
  const byDay = new Map<string, NormalizedMessage[]>();
  for (const m of args.messages) {
    const k = dayKey(m.tsMs);
    const bucket = byDay.get(k);
    if (bucket) bucket.push(m);
    else byDay.set(k, [m]);
  }

  for (const [key, incoming] of byDay) {
    const sourceId = `${chat.key}:${key}`;
    // Read-modify-write of the day doc; assumes single-threaded per-account
    // ingestion so this non-atomic RMW is safe (mirrors Slack's append-to-day).
    const prior = await ctx.findBySourceId('whatsapp', sourceId, DOC_TYPE);
    const priorMessages =
      (prior?.metadata?.messages as NormalizedMessage[] | undefined) ?? [];
    const merged = mergeMessages(priorMessages, incoming);
    const lastTs = merged.length ? merged[merged.length - 1].tsMs : Date.now();

    const metadata: Record<string, unknown> = {
      account_id: String(accountId),
      chat_key: chat.key,
      chat_key_kind: chat.keyKind,
      chat_type: chat.type,
      last_message_at: new Date(lastTs).toISOString(),
      // Retained in full because the next delta re-renders the day's markdown
      // from it (mergeMessages unions prior + incoming).
      messages: merged,
    };
    // Only carry a JID when the chat key actually is one — avoids a noisy
    // `undefined` (and the import path keys on a name slug, not a JID).
    if (chat.keyKind === 'jid') metadata.chat_jid = chat.key;

    const markdown = renderDay(chat.name, merged, args.attachmentDocId);
    await ctx.upsertDocument({
      source: 'whatsapp',
      source_id: sourceId,
      type: DOC_TYPE,
      title: dayTitle(chat.name, key),
      markdown,
      // Re-importing an identical day yields the same hash so the upsert layer
      // can skip rewriting markdown (idempotency parity with Slack threads).
      content_hash: crypto.createHash('sha256').update(markdown).digest('hex'),
      metadata,
      source_url:
        chat.keyKind === 'jid'
          ? `whatsapp://chat?jid=${encodeURIComponent(chat.key)}`
          : '',
      created_at: new Date(merged[0]?.tsMs ?? lastTs),
    });
  }
}

/**
 * Re-render one already-written chat-day doc so a media attachment that
 * downloaded AFTER the day was first flushed gets its `[Attachment](doc://…)`
 * link. The live/backfill path writes the day's text immediately and downloads
 * media in the background; when a download completes this stitches the link in
 * by re-rendering from the doc's own persisted `metadata.messages` (so the
 * runtime needn't keep the messages buffered). No-op if the doc is missing or
 * the markdown is unchanged. Returns whether it rewrote anything.
 */
export async function relinkChatDayMedia(
  ctx: Host,
  sourceId: string,
  attachmentDocId: (msgId: string) => string | undefined,
): Promise<boolean> {
  const prior = await ctx.findBySourceId('whatsapp', sourceId, DOC_TYPE);
  if (!prior) return false;
  const messages =
    (prior.metadata?.messages as NormalizedMessage[] | undefined) ?? [];
  // renderDay derives sender labels from each message, so the chat-name arg is
  // unused — '' is fine here.
  const markdown = renderDay('', messages, attachmentDocId);
  if (markdown === prior.markdown) return false;
  await ctx.upsertDocument({
    source: 'whatsapp',
    source_id: sourceId,
    type: DOC_TYPE,
    title: prior.title,
    markdown,
    content_hash: crypto.createHash('sha256').update(markdown).digest('hex'),
    metadata: prior.metadata,
    source_url: prior.source_url ?? '',
    // On-conflict UPDATE preserves the original created_at; passing the prior
    // value keeps the type happy without shifting the day's corpus date.
    created_at: prior.created_at,
  });
  return true;
}
