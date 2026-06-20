// src/main/connectors/whatsapp/import-parse.ts
import crypto from 'node:crypto';
import * as whatsapp from 'whatsapp-chat-parser';
import type { MediaDescriptor, NormalizedMessage } from './types';

// Media markers. NOTE: English-only — localized WhatsApp exports won't match
// these (known limitation; non-English support is a deferred follow-up).
const IOS_ATTACHED = /<attached:\s*([^>]+)>/i;
const ANDROID_ATTACHED = /^(\S.+?)\s*\(file attached\)\s*$/i;
const OMITTED =
  /(media omitted|image omitted|video omitted|audio omitted|sticker omitted|document omitted)/i;

function mediaFor(filename: string | undefined, raw: string): MediaDescriptor {
  const name = filename ?? '';
  const test = `${name} ${raw}`.toLowerCase();
  let kind: MediaDescriptor['kind'] = 'document';
  if (
    /\.(jpe?g|png|gif|webp|heic|tiff?|bmp)\b/.test(test) ||
    /image|photo/.test(test)
  )
    kind = 'image';
  else if (/\.(mp4|mov|3gp|mkv)\b/.test(test) || /video/.test(test))
    kind = 'video';
  else if (
    /\.(opus|m4a|aac|mp3|ogg)\b/.test(test) ||
    /audio|ptt|voice/.test(test)
  )
    kind = 'audio';
  else if (/sticker/.test(test)) kind = 'sticker';
  return { kind, filename: filename || undefined };
}

// trim() leaves bidi control chars (e.g. the LRM iOS prepends to media lines);
// strip them so a pure-media message yields text: ''.
const stripBidi = (s: string) => s.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();

function detectMedia(message: string): {
  media?: MediaDescriptor;
  text: string;
} {
  const ios = message.match(IOS_ATTACHED);
  if (ios)
    return {
      media: mediaFor(ios[1].trim(), ios[1]),
      text: stripBidi(message.replace(IOS_ATTACHED, '')),
    };
  const android = message.match(ANDROID_ATTACHED);
  if (android)
    return { media: mediaFor(android[1].trim(), android[1]), text: '' };
  if (OMITTED.test(message))
    return { media: mediaFor(undefined, message), text: '' };
  return { text: message };
}

function syntheticId(
  tsMs: number,
  sender: string | null,
  text: string,
  seq: number,
): string {
  const base = `${tsMs}|${sender ?? ''}|${text}`;
  // seq 0 == the old single-arg hash, so the common no-collision case is stable;
  // later same-minute duplicates fold their occurrence index into the input.
  const input = seq === 0 ? base : `${base}#${seq}`;
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/** Parse a WhatsApp `_chat.txt` transcript into NormalizedMessages. */
export function parseExportTranscript(
  raw: string,
  opts: { daysFirst: boolean },
): NormalizedMessage[] {
  // Strip BOM; the parser handles LRM/RLM and both iOS/Android grammars.
  const text = raw.replace(/^\uFEFF/, '');
  const parsed = whatsapp.parseString(text, { daysFirst: opts.daysFirst });
  // Android exports have only minute precision, so two identical (ts, sender,
  // text) messages would otherwise hash to the same id and get collapsed
  // downstream. Count base-key occurrences in stable file order and fold the
  // index into the id, keeping ids unique per transcript yet deterministic
  // across re-imports of the same file.
  const seen = new Map<string, number>();
  return parsed.map((p) => {
    const tsMs = p.date.getTime();
    const rawMsg = p.message ?? '';
    const { media, text: body } = detectMedia(rawMsg);
    const base = `${tsMs}|${p.author ?? ''}|${rawMsg}`;
    const seq = seen.get(base) ?? 0;
    seen.set(base, seq + 1);
    return {
      id: syntheticId(tsMs, p.author ?? null, rawMsg, seq),
      tsMs,
      sender: p.author ?? null, // parser sets author null for system messages
      text: body,
      media,
      system: p.author == null,
    } satisfies NormalizedMessage;
  });
}
