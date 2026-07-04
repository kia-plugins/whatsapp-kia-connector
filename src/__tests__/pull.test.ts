/**
 * End-to-end pull() over a fake socket: the push-events→pull-generator
 * adapter, phase flipping, the store-merged per-day ledger, media batches
 * with parent re-emits, abort, and logout propagation. All offline — the
 * injected makeSocket seam is the only "network".
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WASocket } from '@whiskeysockets/baileys';

import { isAuthError } from '../auth-error';
import { makeFreshAuthState } from '../auth-state';
import { dayKey } from '../chat-day';
import type {
  Account,
  Batch,
  HostFor,
  LogLevel,
  Session,
} from '../kiagent-contracts';
import { createWhatsAppSource } from '../source';
import type {
  DayItem,
  FileItem,
  NormalizedMessage,
  WhatsAppCursor,
  WhatsAppItem,
} from '../types';

type WABatch = Batch<WhatsAppCursor, WhatsAppItem>;

// Local noon: every derived local-day key is stable regardless of runner tz.
const T0_MS = Date.parse('2026-06-11T12:00:00');
const T0_SEC = Math.floor(T0_MS / 1000);
const DAY = dayKey(T0_MS);
const ALICE = 'alice@s.whatsapp.net';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await wait(5);
  }
  throw new Error('waitFor: condition not met in time');
}

interface HarnessOpts {
  flushDebounceMs?: number;
  downloadMedia?: (wm: unknown) => Promise<Buffer | null>;
  /** Prior store ledgers keyed by chat-day externalId. */
  prior?: Record<string, NormalizedMessage[]>;
  /** Omit/point the account config somewhere broken. */
  authFile?: string | null;
  cursor?: WhatsAppCursor | null;
}

async function harness(opts: HarnessOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pull-'));
  let authFile: string;
  if (opts.authFile === undefined) {
    const fresh = makeFreshAuthState();
    fresh.state.creds.me = { id: '111:5@s.whatsapp.net', name: 'Me' } as never;
    authFile = 'auth/111_s.whatsapp.net.bin';
    await fresh.save(path.join(dir, authFile));
  } else {
    authFile = opts.authFile ?? '';
  }

  const ev = new EventEmitter();
  const state = { made: 0, ended: 0 };
  const sock = {
    ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) },
    end: () => {
      state.ended += 1;
    },
    ws: { close: () => {} },
  } as unknown as WASocket;
  const makeSocket = () => {
    state.made += 1;
    return sock;
  };

  const queried: string[] = [];
  const host: HostFor<'net' | 'query'> = {
    self: { id: 'kia.whatsapp', dataDir: dir },
    log: () => {},
    net: {
      fetch: async () => {
        throw new Error('whatsapp source must not use host.net.fetch');
      },
    },
    query: {
      byExternalId: async (_account: string, externalId: string) => {
        queried.push(externalId);
        const messages = opts.prior?.[externalId];
        return messages ? ({ metadata: { messages } } as never) : null;
      },
    } as unknown as HostFor<'net' | 'query'>['query'],
  };

  const source = createWhatsAppSource(host, {
    makeSocketFactory: async () => makeSocket,
    flushDebounceMs: opts.flushDebounceMs ?? 0,
    downloadMedia: (opts.downloadMedia ?? (async () => null)) as never,
  });

  const controller = new AbortController();
  const logs: Array<[LogLevel, string]> = [];
  const session: Session = {
    account: {
      id: 'acc-1',
      source: 'whatsapp',
      identifier: '111@s.whatsapp.net',
      config: authFile ? { authFile } : {},
      status: 'live',
      cursor: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    } as Account,
    signal: controller.signal,
    credentials: async () => null,
    log: (level, msg) => logs.push([level, msg]),
  };

  const it = source
    .pull(session, opts.cursor ?? null)
    [Symbol.asyncIterator]();

  return { dir, authFile, ev, state, queried, source, controller, logs, it };
}

async function nextBatch(
  it: AsyncIterator<WABatch>,
  pending?: Promise<IteratorResult<WABatch>>,
): Promise<WABatch> {
  const r = await (pending ?? it.next());
  expect(r.done).toBe(false);
  return r.value as WABatch;
}

const textMsg = (id: string, sec: number, text: string, jid = ALICE) => ({
  key: { id, remoteJid: jid },
  messageTimestamp: sec,
  message: { conversation: text },
});

describe('pull — pairing preconditions', () => {
  it('throws "not paired" when the account has no authFile config', async () => {
    const h = await harness({ authFile: null });
    await expect(h.it.next()).rejects.toThrow(/not paired — reconnect/);
    expect(h.state.made).toBe(0); // never opened a socket
  });

  it('throws "not paired" when the blob file is missing', async () => {
    const h = await harness({ authFile: 'auth/never-written.bin' });
    await expect(h.it.next()).rejects.toThrow(/not paired — reconnect/);
  });
});

describe('pull — history backfill and live flip', () => {
  it('turns a messaging-history.set into a backfill batch with a merged day item and cursor', async () => {
    const h = await harness();
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    h.ev.emit('messaging-history.set', {
      contacts: [{ id: ALICE, name: 'Alice' }],
      chats: [],
      messages: [
        textMsg('H2', T0_SEC + 60, 'second'),
        textMsg('H1', T0_SEC, 'first'),
      ],
    });

    const batch = await nextBatch(h.it, pending);
    expect(batch.phase).toBe('backfill');
    expect(batch.cursor).toEqual({ lastTsMs: (T0_SEC + 60) * 1000 });
    expect(batch.items).toHaveLength(1);
    const day = batch.items[0] as DayItem;
    expect(day.kind).toBe('day');
    expect(day.chat).toEqual({ jid: ALICE, name: 'Alice', type: 'dm' });
    expect(day.day).toBe(DAY);
    // Sorted ascending regardless of arrival order.
    expect(day.messages.map((m) => m.id)).toEqual(['H1', 'H2']);

    // The mapped document (pure): externalId, dotted type, ledger metadata.
    const doc = h.source.toDocument(day);
    expect(Array.isArray(doc)).toBe(false);
    const d = doc as Exclude<typeof doc, unknown[] | null>;
    expect(d).toMatchObject({
      externalId: `${ALICE}:${DAY}`,
      type: 'whatsapp.chat_day',
      title: 'Alice — Jun 11, 2026',
      url: `whatsapp://chat?jid=${encodeURIComponent(ALICE)}`,
    });
    expect(d.markdown).toContain('Alice: first');
    expect(d.markdown).toContain('Alice: second');
    expect((d.metadata.messages as NormalizedMessage[]).map((m) => m.id)).toEqual(['H1', 'H2']);
    expect(d.createdAt).toBe(new Date(T0_MS).toISOString());

    void h.controller.abort();
    while (!(await h.it.next()).done) {
      /* drain to shutdown */
    }
  });

  it('flips to live on the first messages.upsert and stays live afterwards', async () => {
    const h = await harness();
    let pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    h.ev.emit('messaging-history.set', {
      contacts: [],
      chats: [],
      messages: [textMsg('H1', T0_SEC, 'old history')],
    });
    const first = await nextBatch(h.it, pending);
    expect(first.phase).toBe('backfill');

    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [textMsg('L1', T0_SEC + 120, 'live now')],
    });
    const second = await nextBatch(h.it);
    expect(second.phase).toBe('live');
    expect((second.items[0] as DayItem).messages.map((m) => m.id)).toEqual(['H1', 'L1']);
    expect(second.cursor).toEqual({ lastTsMs: (T0_SEC + 120) * 1000 });

    // A late history chunk after the live flip still yields phase 'live'.
    h.ev.emit('messaging-history.set', {
      contacts: [],
      chats: [],
      messages: [textMsg('H9', T0_SEC + 30, 'straggler history')],
    });
    const third = await nextBatch(h.it);
    expect(third.phase).toBe('live');

    void h.controller.abort();
    while (!(await h.it.next()).done) {
      /* drain */
    }
  });

  it('does not regress the cursor below the incoming floor', async () => {
    const floor = (T0_SEC + 9999) * 1000;
    const h = await harness({ cursor: { lastTsMs: floor } });
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);
    h.ev.emit('messaging-history.set', {
      contacts: [],
      chats: [],
      messages: [textMsg('H1', T0_SEC, 'older than the floor')],
    });
    const batch = await nextBatch(h.it, pending);
    expect(batch.cursor).toEqual({ lastTsMs: floor });

    void h.controller.abort();
    while (!(await h.it.next()).done) {
      /* drain */
    }
  });
});

describe('pull — store-merge (survives restarts without re-delivery)', () => {
  it('unions the prior metadata.messages ledger into the emitted day, fetching it once per (chat, day)', async () => {
    const priorOld: NormalizedMessage = {
      id: 'OLD1',
      tsMs: T0_MS - 3_600_000, // 11:00 same local day
      sender: 'Alice',
      text: 'from a previous run',
      system: false,
    };
    const h = await harness({ prior: { [`${ALICE}:${DAY}`]: [priorOld] } });
    let pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [textMsg('NEW1', T0_SEC, 'fresh')],
    });
    const batch = await nextBatch(h.it, pending);
    const day = batch.items[0] as DayItem;
    expect(day.messages.map((m) => m.id)).toEqual(['OLD1', 'NEW1']);
    expect(h.queried).toEqual([`${ALICE}:${DAY}`]);

    // Another message on the same day: the store is NOT re-consulted.
    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [textMsg('NEW2', T0_SEC + 5, 'again')],
    });
    const batch2 = await nextBatch(h.it);
    expect((batch2.items[0] as DayItem).messages.map((m) => m.id)).toEqual([
      'OLD1',
      'NEW1',
      'NEW2',
    ]);
    expect(h.queried).toEqual([`${ALICE}:${DAY}`]);

    void h.controller.abort();
    while (!(await h.it.next()).done) {
      /* drain */
    }
  });

  it('leaves a day dirty and retries when the prior-ledger read fails (no shrunken ledger ever emitted)', async () => {
    const h = await harness();
    // First read throws, later reads succeed.
    let calls = 0;
    const query = { byExternalId: async () => {
      calls += 1;
      if (calls === 1) throw new Error('store hiccup');
      return null;
    } };
    // Rebuild a source over the failing query but the same socket/auth.
    const source = createWhatsAppSource(
      {
        self: { id: 'kia.whatsapp', dataDir: h.dir },
        log: () => {},
        net: { fetch: async () => ({}) },
        query: query as never,
      },
      {
        makeSocketFactory: async () => () => {
          h.state.made += 1;
          return {
            ev: { on: h.ev.on.bind(h.ev), off: h.ev.off.bind(h.ev) },
            end: () => {},
            ws: { close: () => {} },
          } as never;
        },
        flushDebounceMs: 0,
        downloadMedia: async () => null,
      },
    );
    const controller = new AbortController();
    const session: Session = {
      account: {
        id: 'acc-1',
        source: 'whatsapp',
        identifier: 'x',
        config: { authFile: h.authFile },
        status: 'live',
        cursor: null,
        createdAt: '',
      } as Account,
      signal: controller.signal,
      credentials: async () => null,
      log: () => {},
    };
    const it = source.pull(session, null)[Symbol.asyncIterator]();
    const pending = it.next();
    await waitFor(() => h.state.made >= 1);

    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [textMsg('M1', T0_SEC, 'hello')],
    });
    // First flush failed its store read → nothing emitted; a follow-up
    // message triggers a new flush which now succeeds and carries BOTH.
    await waitFor(() => calls >= 1);
    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [textMsg('M2', T0_SEC + 1, 'world')],
    });
    const batch = await nextBatch(it, pending);
    expect((batch.items[0] as DayItem).messages.map((m) => m.id)).toEqual(['M1', 'M2']);

    void controller.abort();
    while (!(await it.next()).done) {
      /* drain */
    }
  });
});

describe('pull — media', () => {
  const imgMsg = (id: string, sec: number, caption: string) => ({
    key: { id, remoteJid: ALICE },
    messageTimestamp: sec,
    message: { imageMessage: { caption, mimetype: 'image/jpeg' } },
  });

  it('emits downloaded bytes as a file item in one batch with a re-emit of its parent day', async () => {
    const h = await harness({
      downloadMedia: async () => Buffer.from('img-bytes'),
    });
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [imgMsg('IMG1', T0_SEC, 'holiday pic')],
    });

    // Depending on which wins the race between the debounced text flush and
    // the (instant) media emit, the file item arrives in the first or second
    // batch — collect until it shows up.
    const batches: WABatch[] = [await nextBatch(h.it, pending)];
    while (!batches.some((x) => x.items.some((i) => i.kind === 'file'))) {
      batches.push(await nextBatch(h.it));
    }
    const mediaBatch = batches.find((x) => x.items.some((i) => i.kind === 'file'))!;
    expect(mediaBatch.items).toHaveLength(2);
    const [day, file] = mediaBatch.items as [DayItem, FileItem];
    expect(day.kind).toBe('day'); // parent rides the same commit
    expect(day.messages[0].media).toMatchObject({ kind: 'image' });
    expect(file).toMatchObject({
      kind: 'file',
      chatJid: ALICE,
      day: DAY,
      msgId: 'IMG1',
      mimeType: 'image/jpeg',
      sentAtMs: T0_SEC * 1000,
    });
    expect(Buffer.from(file.bytes).toString()).toBe('img-bytes');

    // The mapped file document: binary bytes, parent edge, no markdown.
    const doc = h.source.toDocument(file) as Exclude<
      ReturnType<typeof h.source.toDocument>,
      unknown[] | null
    >;
    expect(doc).toMatchObject({
      externalId: `${ALICE}:IMG1`,
      type: 'file',
      title: 'attachment',
      markdown: null,
      parent: { externalId: `${ALICE}:${DAY}`, type: 'whatsapp.chat_day' },
      createdAt: new Date(T0_SEC * 1000).toISOString(),
    });
    expect(doc.binary).toMatchObject({ mime: 'image/jpeg' });
    expect(doc.metadata).toMatchObject({
      chat_key: ALICE,
      size_bytes: 9,
      mime_type: 'image/jpeg',
    });
    // Day markdown carries the label, never a doc:// link (v2 deviation).
    const dayDoc = h.source.toDocument(day) as { markdown: string };
    expect(dayDoc.markdown).toContain('[image]');
    expect(dayDoc.markdown).not.toContain('doc://');

    void h.controller.abort();
    while (!(await h.it.next()).done) {
      /* drain */
    }
  });

  it('downloads media strictly one at a time (ban-risk discipline)', async () => {
    const started: string[] = [];
    let release: (() => void) | null = null;
    const h = await harness({
      downloadMedia: async (wm) => {
        const id = (wm as { key: { id: string } }).key.id;
        started.push(id);
        await new Promise<void>((r) => {
          release = r;
        });
        return Buffer.from(`bytes-${id}`);
      },
    });
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [imgMsg('IMG1', T0_SEC, 'one'), imgMsg('IMG2', T0_SEC + 1, 'two')],
    });

    await waitFor(() => started.length === 1);
    await wait(20); // give a (buggy) concurrent second download time to start
    expect(started).toEqual(['IMG1']); // second NOT started while first is in flight
    release!();
    await waitFor(() => started.length === 2);
    expect(started).toEqual(['IMG1', 'IMG2']);
    release!();

    // Drain: the text flush plus two media batches, each [day, file].
    const batches: WABatch[] = [await nextBatch(h.it, pending)];
    batches.push(await nextBatch(h.it));
    batches.push(await nextBatch(h.it));
    const files = batches.flatMap((x) =>
      x.items.filter((i): i is FileItem => i.kind === 'file'),
    );
    expect(files.map((f) => f.msgId)).toEqual(['IMG1', 'IMG2']);

    void h.controller.abort();
    while (!(await h.it.next()).done) {
      /* drain */
    }
  });

  it('downloads a re-delivered history chunk\'s media exactly once (Baileys re-delivers on reconnect)', async () => {
    let downloads = 0;
    const h = await harness({
      downloadMedia: async () => {
        downloads += 1;
        return Buffer.from('x');
      },
    });
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    const chunk = {
      contacts: [],
      chats: [],
      messages: [imgMsg('IMG1', T0_SEC, 'cap')],
    };
    h.ev.emit('messaging-history.set', chunk);
    h.ev.emit('messaging-history.set', chunk); // re-delivered

    // Collect until the file item lands, then drain via abort.
    const batches: WABatch[] = [await nextBatch(h.it, pending)];
    while (!batches.some((x) => x.items.some((i) => i.kind === 'file'))) {
      batches.push(await nextBatch(h.it));
    }
    void h.controller.abort();
    for (;;) {
      const r = await h.it.next();
      if (r.done) break;
      batches.push(r.value);
    }

    expect(downloads).toBe(1);
    const files = batches.flatMap((x) => x.items.filter((i) => i.kind === 'file'));
    expect(files).toHaveLength(1);
  });

  it('never re-downloads media the store already holds as a file doc (cross-run idempotency)', async () => {
    let downloads = 0;
    const h = await harness({
      // Any truthy doc for the file externalId ⇒ hasStoredFile → true.
      prior: { [`${ALICE}:IMG9`]: [] },
      downloadMedia: async () => {
        downloads += 1;
        return Buffer.from('x');
      },
    });
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [imgMsg('IMG9', T0_SEC, 'already ingested last run')],
    });

    const batch = await nextBatch(h.it, pending); // the day still flushes
    expect(batch.items[0].kind).toBe('day');
    await waitFor(() => h.queried.includes(`${ALICE}:IMG9`)); // check ran
    await wait(20);
    expect(downloads).toBe(0);

    void h.controller.abort();
    const rest: WABatch[] = [];
    for (;;) {
      const r = await h.it.next();
      if (r.done) break;
      rest.push(r.value);
    }
    expect(rest.flatMap((x) => x.items).some((i) => i.kind === 'file')).toBe(false);
  });

  it('abort during a stalled download returns promptly and never emits the straggler', async () => {
    let downloads = 0;
    const h = await harness({
      downloadMedia: async () => {
        downloads += 1;
        await new Promise<void>(() => {}); // wedged CDN fetch: never settles
        return null;
      },
    });
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [imgMsg('IMG1', T0_SEC, 'cap')],
    });
    const first = await nextBatch(h.it, pending); // text flush lands fine
    expect(first.items[0].kind).toBe('day');
    await waitFor(() => downloads === 1); // the download is now in flight

    const t0 = Date.now();
    h.controller.abort();
    const rest: WABatch[] = [];
    for (;;) {
      const r = await h.it.next();
      if (r.done) break;
      rest.push(r.value);
    }
    // Bounded stop: the wedged download can't hold the generator hostage…
    expect(Date.now() - t0).toBeLessThan(1500);
    // …and nothing media-related is ever emitted after the abort.
    expect(rest.flatMap((x) => x.items).some((i) => i.kind === 'file')).toBe(false);
  });

  it('skips media whose download yields nothing (placeholder stays)', async () => {
    const h = await harness({ downloadMedia: async () => null });
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);
    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [imgMsg('IMG1', T0_SEC, 'cap')],
    });
    const batch = await nextBatch(h.it, pending);
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0].kind).toBe('day');

    void h.controller.abort();
    const rest: WABatch[] = [];
    for (;;) {
      const r = await h.it.next();
      if (r.done) break;
      rest.push(r.value);
    }
    // No file item ever appears.
    expect(rest.flatMap((x) => x.items).some((i) => i.kind === 'file')).toBe(false);
  });
});

describe('pull — shutdown paths', () => {
  it('abort stops the socket, flushes buffered days as a final batch, and returns', async () => {
    // Huge debounce: only the abort-time final flush can emit the batch.
    const h = await harness({ flushDebounceMs: 60_000 });
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [textMsg('L1', T0_SEC, 'buffered, never debounce-flushed')],
    });
    await wait(10); // let ingest land
    h.controller.abort();

    const finalBatch = await nextBatch(h.it, pending);
    expect((finalBatch.items[0] as DayItem).messages.map((m) => m.id)).toEqual(['L1']);
    const done = await h.it.next();
    expect(done.done).toBe(true);
    expect(h.state.ended).toBeGreaterThanOrEqual(1); // socket was stopped
  });

  it('completes immediately when aborted before any event', async () => {
    const h = await harness();
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);
    h.controller.abort();
    const r = await pending;
    expect(r.done).toBe(true);
  });

  it('propagates a 401 logout as an auth error after draining, with a final blob persist', async () => {
    const h = await harness();
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    // If the loggedOut path best-effort-persists, the blob reappears.
    const blobPath = path.join(h.dir, h.authFile);
    fs.rmSync(blobPath);

    h.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    let thrown: unknown;
    try {
      let r = await pending;
      while (!r.done) r = await h.it.next();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toMatch(/logged out .*reconnect the account/);
    expect(isAuthError(thrown)).toBe(true);
    expect(fs.existsSync(blobPath)).toBe(true); // the "final persist" happened
  });

  it('re-persists the auth blob on creds.update (key rotation)', async () => {
    const h = await harness();
    const pending = h.it.next();
    await waitFor(() => h.state.made === 1);

    const blobPath = path.join(h.dir, h.authFile);
    fs.rmSync(blobPath); // if saveCreds runs, the file reappears
    h.ev.emit('creds.update', {});
    await waitFor(() => fs.existsSync(blobPath));

    void h.controller.abort();
    let r = await pending;
    while (!r.done) r = await h.it.next();
  });
});
