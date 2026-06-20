// src/main/connectors/whatsapp/import-file.ts
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Converter } from './host';
import type { Host } from './host';
import type { ChatRef } from './types';
import { parseExportTranscript } from './import-parse';
import { upsertChatDays, dayKey } from './chat-day';
import { storeMedia, MEDIA_SIZE_CAP_BYTES } from './media';

const TS_LINE = /^(?:‎|‏)*\[?\d{1,4}[-/.]/; // iOS/Android first-line grammar

function looksLikeTranscript(text: string): boolean {
  return text
    .split('\n')
    .slice(0, 5)
    .some((l) => TS_LINE.test(l));
}

function inferDaysFirst(text: string): boolean {
  // If any first date component exceeds 12 it must be the day → day-first.
  for (const m of text.matchAll(/^[^\d]*(\d{1,4})[-/.](\d{1,4})/gm)) {
    const a = Number(m[1]);
    if (a > 12 && a <= 31) return true;
    if (a > 31) return false;
  }
  return false; // default month-first (US/iOS default)
}

function nameKey(chatName: string): string {
  const slug = chatName
    .normalize('NFKD') // ü → u + combining ¨
    .replace(/[̀-ͯ]/g, '') // strip combining marks → Müller→muller, Möller→moller (distinct)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  if (slug) return `name:${slug}`;
  // Non-Latin / emoji-only names → stable hash key so distinct chats don't merge.
  const h = crypto
    .createHash('sha1')
    .update(chatName.trim())
    .digest('hex')
    .slice(0, 12);
  return `name:${h}`;
}

/** Core import from an already-extracted transcript + media map. Unit-testable. */
export async function importTranscriptText(args: {
  ctx: Host;
  accountId: bigint;
  baseDir: string;
  converter: Converter;
  chatName: string;
  transcript: string;
  mediaFiles: Map<string, Buffer>; // filename → bytes (from the zip)
}): Promise<{ days: number; messages: number }> {
  const messages = parseExportTranscript(args.transcript, {
    daysFirst: inferDaysFirst(args.transcript),
  });
  // Infer dm/group from distinct human senders: a DM transcript has at most two
  // participants (you + them). The e2e-encryption system notice opens nearly
  // every export, so keying off `m.system` would mislabel DMs as groups.
  const senders = new Set(
    messages.filter((m) => !m.system && m.sender).map((m) => m.sender),
  );
  const chat: ChatRef = {
    keyKind: 'name',
    key: nameKey(args.chatName),
    name: args.chatName,
    type: senders.size > 2 ? 'group' : 'dm',
  };

  // Copy any referenced media into the cache + emit file docs; remember doc ids.
  const docIdByMsg = new Map<string, string>();
  for (const m of messages) {
    const filename = m.media?.filename;
    const bytes = filename ? args.mediaFiles.get(filename) : undefined;
    if (!bytes || bytes.length > MEDIA_SIZE_CAP_BYTES) continue;
    const docId = await storeMedia({
      ctx: args.ctx,
      accountId: args.accountId,
      baseDir: args.baseDir,
      converter: args.converter,
      chatKey: chat.key,
      msgId: m.id,
      sentAtMs: m.tsMs,
      bytes,
      filename,
      mimeType: m.media?.mimeType,
    });
    docIdByMsg.set(m.id, docId);
  }

  await upsertChatDays({
    ctx: args.ctx,
    accountId: args.accountId,
    chat,
    messages,
    attachmentDocId: (id) => docIdByMsg.get(id),
  });

  // Reuse dayKey so the count stays in lockstep with the doc grouping.
  const days = new Set(messages.map((m) => dayKey(m.tsMs))).size;
  return { days, messages: messages.length };
}

/** Entry point for the IPC handler: a path to a .zip or a _chat.txt. */
export async function importChatFile(args: {
  ctx: Host;
  accountId: bigint;
  baseDir: string;
  converter: Converter;
  filePath: string;
}): Promise<
  { ok: true; days: number; messages: number } | { ok: false; error: string }
> {
  let transcript = '';
  let chatName = path.basename(args.filePath).replace(/\.(zip|txt)$/i, '');
  const mediaFiles = new Map<string, Buffer>();

  if (/\.zip$/i.test(args.filePath)) {
    try {
      const zip = new AdmZip(args.filePath);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const isTxt = /\.txt$/i.test(entry.entryName);
        // We must still decompress .txt candidates to sniff the transcript, but
        // skip media (non-.txt) entries whose uncompressed size is over the cap
        // so a 200MB video isn't decompressed into memory just to be discarded.
        if (!isTxt && entry.header.size > MEDIA_SIZE_CAP_BYTES) continue;
        const data = entry.getData();
        const text = isTxt ? data.toString('utf8') : '';
        if (!transcript && isTxt && looksLikeTranscript(text)) {
          transcript = text;
          const m = entry.entryName.match(/WhatsApp Chat with (.+)\.txt$/i);
          if (m) [, chatName] = m;
        } else {
          mediaFiles.set(path.basename(entry.entryName), data);
        }
      }
    } catch (e) {
      return {
        ok: false,
        error: `Failed to read WhatsApp export zip: ${(e as Error).message}`,
      };
    }
  } else {
    try {
      transcript = await fsp.readFile(args.filePath, 'utf8');
    } catch (e) {
      return {
        ok: false,
        error: `Failed to read transcript file: ${(e as Error).message}`,
      };
    }
  }

  if (!transcript || !looksLikeTranscript(transcript)) {
    return {
      ok: false,
      error: 'No WhatsApp transcript (_chat.txt) found in the file.',
    };
  }
  const r = await importTranscriptText({
    ...args,
    chatName,
    transcript,
    mediaFiles,
  });
  return { ok: true, ...r };
}
