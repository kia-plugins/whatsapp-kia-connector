/**
 * Startup scan for stored day docs rendered without a real name — the chat
 * name or (in a DM) the other person's sender name came out as a number,
 * because the name was not known when the day was written (a fresh link
 * re-renders a whole year of days before WhatsApp sends contact names, and
 * names were once keyed only by phone while chats are keyed by LID).
 *
 * The runtime re-renders each such day as soon as it knows the name: at once
 * when the persisted contact book already has it, otherwise when the name
 * arrives during the run. Paging mirrors outbound.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AccountId, HostFor } from '@kiagent/connector-sdk';

import { DOC_TYPE } from './chat-day';
import { isFallbackName } from './contacts';
import type { StoredFallbackDay } from './runtime';

const PAGE = 200;

/** True when a stored day doc shows a number where a name belongs. */
export function storedDayUnnamed(metadata: Record<string, unknown>): boolean {
  if (isFallbackName(metadata.chat_name)) return true;
  if (metadata.chat_type === 'group') return false;
  const messages = metadata.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    const r = m as { sender?: unknown; system?: unknown };
    return !r.system && r.sender !== 'You' && isFallbackName(r.sender);
  });
}

export async function* unnamedStoredDays(
  host: HostFor<'query'>,
  account: AccountId,
): AsyncGenerator<StoredFallbackDay[]> {
  for (let offset = 0; ; offset += PAGE) {
    const page = await host.query.search({
      type: DOC_TYPE,
      account,
      orderBy: 'newest',
      limit: PAGE,
      offset,
    });
    const chunk: StoredFallbackDay[] = [];
    for (const doc of page) {
      const m = doc.metadata as Record<string, unknown>;
      const jid = m.chat_key;
      const sep = doc.externalId.lastIndexOf(':');
      if (typeof jid !== 'string' || sep < 0) continue;
      const day = doc.externalId.slice(sep + 1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (storedDayUnnamed(m)) chunk.push({ jid, day });
    }
    if (chunk.length) yield chunk;
    if (page.length < PAGE) return;
  }
}

/** contacts.json under the extension dataDir, one per account. Failures are
 *  swallowed: names are a cache WhatsApp re-sends. Writes are atomic. */
export function fileContactStore(file: string): {
  read(): unknown;
  write(snapshot: unknown): void;
} {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return undefined;
      }
    },
    write(snapshot) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.part`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, file);
    },
  };
}
