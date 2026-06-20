// src/main/connectors/whatsapp/media.ts
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './host';
import type { Converter } from './host';
import type { Host } from './host';

export const FILE_DOC_TYPE = 'file';

/** Download cap; larger media stays a placeholder (no bytes fetched). */
export const MEDIA_SIZE_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Persist media bytes to the cache, first-pass-convert, and upsert a `file`
 * doc. markdown is null for images/scanned PDFs so classifyDocument enrolls
 * them into deep-extraction; converter text (PDF/docx) is stored directly.
 * Returns the doc's stringified id (for linking from the day doc).
 */
export async function storeMedia(args: {
  ctx: Host;
  accountId: bigint;
  baseDir: string;
  converter: Converter;
  chatKey: string;
  msgId: string;
  /** Epoch-ms send time of the message carrying this media (drives created_at). */
  sentAtMs: number;
  bytes: Buffer;
  filename?: string;
  mimeType?: string;
}): Promise<string> {
  const { ctx, bytes } = args;
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fsp.mkdir(args.baseDir, { recursive: true });
  // Write to a temp sibling then rename: a crash mid-write must never leave a
  // partial file whose NAME is the full-content hash (reads don't re-validate,
  // so corrupt bytes could later reach OCR). Rename within the same dir is
  // atomic on local filesystems (mirrors deep-extraction/runtime/downloader).
  const finalPath = path.join(args.baseDir, hash);
  const tmpPath = `${finalPath}.part`;
  await fsp.writeFile(tmpPath, bytes, { mode: 0o600 });
  await fsp.rename(tmpPath, finalPath);

  let markdown: string | null = null;
  try {
    // Mirror slack/thread-builder's attachment convert: mimeType is required by
    // ConvertInput (default '' when unknown) and filename drives extension-based
    // mime resolution for sources that omit a usable mimeType.
    const conv = await args.converter.convert({
      kind: 'bytes',
      bytes,
      mimeType: args.mimeType ?? '',
      filename: args.filename,
    });
    markdown = conv?.markdown ?? null;
  } catch {
    markdown = null; // unsupported (e.g. image) or backpressure → deep-extraction handles it
  }

  // Avoid writing literal `undefined` into metadata (chat-day.ts precedent);
  // only carry filename/mime_type when actually provided.
  const metadata: Record<string, unknown> = {
    account_id: String(args.accountId),
    chat_key: args.chatKey,
    size_bytes: bytes.length,
    extraction_status: markdown ? 'ok' : 'unsupported',
  };
  if (args.filename !== undefined) metadata.filename = args.filename;
  if (args.mimeType !== undefined) metadata.mime_type = args.mimeType;

  const id = await ctx.upsertDocument({
    source: 'whatsapp',
    source_id: `${args.chatKey}:${args.msgId}`,
    type: FILE_DOC_TYPE,
    title: args.filename ?? 'attachment',
    markdown,
    metadata,
    source_url: '',
    content_hash: hash,
    created_at: new Date(args.sentAtMs),
  });
  return String(id);
}

/**
 * Delete cached media bytes for whatsapp `file` docs once they are fully
 * processed. The cache is content-addressed (the on-disk filename IS the
 * sha256 content_hash), so identical media reused across many messages yields
 * MULTIPLE `file` docs (distinct source_id) all pointing at the ONE cache
 * file. The cleanup is therefore HASH-WIDE: a shared cache file is removed
 * ONLY once EVERY whatsapp `file` doc sharing that content_hash is done with
 * the bytes — i.e. (a) at least one such doc is deletable (markdown present
 * OR a terminal deep_extractions row done/skipped/failed), AND (b) NO such doc
 * still needs the bytes. A doc "still needs the bytes" iff its markdown IS NULL
 * and it has no terminal deep row — covering in-flight pending/processing/
 * ocr_done AND not-yet-enrolled images. This protects siblings that still need
 * the bytes (there is no network re-fetch on the M1 import path).
 * Idempotent; returns the count of files actually removed.
 */
export async function sweepMediaCache(
  db: Db,
  baseDir: string,
): Promise<number> {
  const rows = await db.all(
    `SELECT d.content_hash AS h
       FROM documents d
      WHERE d.source = 'whatsapp' AND d.type = 'file' AND d.content_hash IS NOT NULL
        -- at least one doc sharing this hash is fully processed (safe to drop bytes for it)
        AND EXISTS (
          SELECT 1 FROM documents dd
           WHERE dd.content_hash = d.content_hash AND dd.source = 'whatsapp' AND dd.type = 'file'
             AND (
               dd.markdown IS NOT NULL
               OR EXISTS (SELECT 1 FROM deep_extractions de
                           WHERE de.document_id = dd.id AND de.state IN ('done','skipped','failed'))
             )
        )
        -- and NO doc sharing this hash still needs the bytes (in-flight or awaiting extraction)
        AND NOT EXISTS (
          SELECT 1 FROM documents dn
           WHERE dn.content_hash = d.content_hash AND dn.source = 'whatsapp' AND dn.type = 'file'
             AND dn.markdown IS NULL
             AND NOT EXISTS (SELECT 1 FROM deep_extractions de
                              WHERE de.document_id = dn.id AND de.state IN ('done','skipped','failed'))
        )
      GROUP BY d.content_hash`,
  );
  let removed = 0;
  for (const r of rows) {
    const p = path.join(baseDir, r.h as string);
    try {
      await fsp.rm(p);
      removed++;
    } catch {
      // best-effort: already gone (idempotent re-sweep) or unreadable
    }
  }
  return removed;
}
