import { EventEmitter } from 'node:events';

import type { DocumentInput, HostFor } from '@kiagent/connector-sdk';
import { liveRuntime, markLoggedOut, registerLive, type LiveRuntime } from '../live';
import { migrationItems, outboundFor, parseOutboundRef } from '../outbound';
import { createWhatsAppSender } from '../sender';
import { WhatsAppSocket } from '../socket';
import { createWhatsAppSource } from '../source';

/** A Baileys socket fake whose `ws` delivers server acks and whose
 *  sendMessage is scripted per test. */
function ackingSocket(sendMessage: (jid: string, content: unknown, opts: { messageId: string }) => Promise<unknown>) {
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  const sock = {
    ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) },
    ws: Object.assign(ws, { close: jest.fn() }),
    end: jest.fn(),
    sendMessage: jest.fn(sendMessage),
  };
  const s = new WhatsAppSocket({
    makeSocket: () => sock as never,
    onQr: () => {},
    onConnected: () => {},
    onLoggedOut: () => {},
    onMessages: () => {},
    onHistory: () => {},
    reconnectBaseMs: 1_000_000, // no reconnect inside a test
  });
  const ack = (attrs: Record<string, string>) => ws.emit('CB:ack,class:message', { tag: 'ack', attrs });
  return { s, sock, ev, ack };
}

describe('whatsapp reply targets', () => {
  it('a day doc of a person or group carries a chat-level target, plus its chat name', () => {
    const src = createWhatsAppSource({ self: { id: 'x', dataDir: '/tmp' } } as never);
    const doc = src.toDocument({
      kind: 'day',
      chat: { jid: '4915112345@s.whatsapp.net', name: 'Anna', type: 'dm' },
      day: '2026-09-30',
      messages: [{ id: 'A1', tsMs: 1, sender: 'Anna', text: 'hi', system: false }],
    }) as DocumentInput;
    expect(doc.metadata.outbound).toEqual({ ref: { jid: '4915112345@s.whatsapp.net' }, display: 'Anna' });
    expect(doc.metadata.chat_name).toBe('Anna');
  });

  it('never for broadcasts or channels', () => {
    for (const jid of ['status@broadcast', '123@broadcast', '120363@newsletter'])
      expect(outboundFor({ jid, name: 'x', type: 'dm' })).toBeUndefined();
    expect(outboundFor({ jid: '120363@g.us', name: 'Team', type: 'group' })).toBeDefined();
    expect(outboundFor({ jid: '9876@lid', name: 'Bo', type: 'dm' })).toBeDefined();
    expect(parseOutboundRef({ jid: 'status@broadcast' })).toBeNull();
  });
});

describe('reply-target migration', () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 8, 30);
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  const doc = (jid: string, day: string, daysAgo: number, extra: Record<string, unknown> = {}) => ({
    externalId: `${jid}:${day}`,
    title: `Anna — Sep 1, 2026`,
    createdAt: iso(daysAgo),
    metadata: {
      chat_key: jid,
      chat_type: 'dm',
      messages: [{ id: day, tsMs: 1, sender: 'Anna', text: 'x', system: false }],
      ...extra,
    },
  });

  function host(stored: ReturnType<typeof doc>[]) {
    const queries: unknown[] = [];
    return {
      queries,
      host: {
        query: {
          search: async (q: { offset: number; limit: number }) => {
            queries.push(q);
            return stored.slice(q.offset, q.offset + q.limit);
          },
        },
      } as unknown as HostFor<'query'>,
    };
  }

  it('re-emits the newest day of every chat and every day inside the window, newest first', async () => {
    const stored = [
      doc('a@s.whatsapp.net', '2026-09-29', 1),
      doc('a@s.whatsapp.net', '2026-09-10', 20),
      doc('a@s.whatsapp.net', '2026-06-01', 120), // old, not the newest of its chat
      doc('b@s.whatsapp.net', '2026-03-01', 200), // old, but the newest of its chat
    ];
    const { host: h, queries } = host(stored);
    const chunks: string[][] = [];
    for await (const c of migrationItems(h, 'acc' as never, NOW)) chunks.push(c.map((i) => `${i.chat.jid}:${i.day}`));
    expect(chunks.flat()).toEqual([
      'a@s.whatsapp.net:2026-09-29',
      'a@s.whatsapp.net:2026-09-10',
      'b@s.whatsapp.net:2026-03-01',
    ]);
    expect(queries[0]).toMatchObject({ type: 'whatsapp.chat_day', account: 'acc', orderBy: 'newest' });
  });

  it('rebuilds the item the way toDocument wrote it (name from the title, ledger, type)', async () => {
    const { host: h } = host([doc('a@s.whatsapp.net', '2026-09-29', 1)]);
    const [[item]] = await (async () => {
      const out = [];
      for await (const c of migrationItems(h, 'acc' as never, NOW)) out.push(c);
      return out;
    })();
    expect(item).toEqual({
      kind: 'day',
      chat: { jid: 'a@s.whatsapp.net', name: 'Anna', type: 'dm' },
      day: '2026-09-29',
      messages: [{ id: '2026-09-29', tsMs: 1, sender: 'Anna', text: 'x', system: false }],
    });
  });

  it('skips docs that already carry a target', async () => {
    const { host: h } = host([doc('a@s.whatsapp.net', '2026-09-29', 1, { outbound: { ref: {} } })]);
    const out = [];
    for await (const c of migrationItems(h, 'acc' as never, NOW)) out.push(...c);
    expect(out).toEqual([]);
  });

  it('pages until a short page', async () => {
    const stored = Array.from({ length: 450 }, (_, i) => doc(`${i}@s.whatsapp.net`, '2026-09-29', 1));
    const { host: h, queries } = host(stored);
    let n = 0;
    for await (const c of migrationItems(h, 'acc' as never, NOW)) n += c.length;
    expect(n).toBe(450);
    expect(queries.map((q) => (q as { offset: number }).offset)).toEqual([0, 200, 400]);
  });
});

describe('live runtime registry', () => {
  it('an old pull’s late cleanup never removes its replacement', () => {
    const oldRt: LiveRuntime = { sendText: async () => 'old' };
    const newRt: LiveRuntime = { sendText: async () => 'new' };
    const unregisterOld = registerLive('acc-r', oldRt);
    const unregisterNew = registerLive('acc-r', newRt);
    unregisterOld();
    expect(liveRuntime('acc-r')).toBe(newRt);
    unregisterNew();
    expect(liveRuntime('acc-r')).toBeUndefined();
  });
});

describe('WhatsAppSocket.sendText', () => {
  afterEach(() => jest.useRealTimers());

  it('refuses (provably unsent) before the socket is open', async () => {
    const { s, sock } = ackingSocket(async () => ({}));
    await s.start();
    await expect(s.sendText('a@s.whatsapp.net', 'hi', 1000)).rejects.toThrow(/^not sent: /);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('resolves only on the server ack for ITS pre-generated id — never on the write alone', async () => {
    const { s, sock, ev, ack } = ackingSocket(async () => ({}));
    await s.start();
    ev.emit('connection.update', { connection: 'open' });
    let done = false;
    const p = s.sendText('a@s.whatsapp.net', 'hi', 5000).then((id) => {
      done = true;
      return id;
    });
    await new Promise((r) => setImmediate(r));
    const { messageId } = sock.sendMessage.mock.calls[0][2];
    expect(sock.sendMessage.mock.calls[0].slice(0, 2)).toEqual(['a@s.whatsapp.net', { text: 'hi' }]);
    expect(done).toBe(false); // written, not yet acknowledged
    ack({ id: 'SOMEONE-ELSE' });
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    ack({ id: messageId });
    await expect(p).resolves.toBe(messageId);
  });

  it('an ack carrying an error is a failure that does not claim "not sent"', async () => {
    const { s, sock, ev, ack } = ackingSocket(async () => ({}));
    await s.start();
    ev.emit('connection.update', { connection: 'open' });
    const p = s.sendText('a@s.whatsapp.net', 'hi', 5000);
    await new Promise((r) => setImmediate(r));
    ack({ id: sock.sendMessage.mock.calls[0][2].messageId, error: '479' });
    const err = await p.then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/error 479/);
    expect(err?.message).not.toMatch(/^not sent:/);
  });

  it('at the deadline it ENDS the socket (nothing still being prepared can go out) and reports unconfirmed', async () => {
    const { s, sock, ev } = ackingSocket(() => new Promise(() => {})); // stuck in device lookup
    await s.start();
    ev.emit('connection.update', { connection: 'open' });
    const err = await s.sendText('a@s.whatsapp.net', 'hi', 10).then(() => null, (e: Error) => e);
    expect(err?.message).toBe('WhatsApp did not confirm the message in time');
    expect(sock.end).toHaveBeenCalledTimes(1);
  });

  it('a closed or stopped socket refuses', async () => {
    const { s, ev } = ackingSocket(async () => ({}));
    await s.start();
    ev.emit('connection.update', { connection: 'open' });
    ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('x') } });
    await expect(s.sendText('a@s.whatsapp.net', 'hi', 1000)).rejects.toThrow(/^not sent: /);
    ev.emit('connection.update', { connection: 'open' });
    await s.stop();
    await expect(s.sendText('a@s.whatsapp.net', 'hi', 1000)).rejects.toThrow(/^not sent: /);
  });
});

describe('whatsapp sender', () => {
  const intent = (ref: unknown) => ({
    accountId: 'acc-s' as never,
    kind: 'reply' as const,
    outboundRef: ref,
    bodyMarkdown: 'On my way',
  });

  it('sends through the account’s live runtime and returns the acknowledged id', async () => {
    const sendText = jest.fn(async () => 'MSG-1');
    const unregister = registerLive('acc-s', { sendText });
    try {
      await expect(createWhatsAppSender().send(intent({ jid: 'a@s.whatsapp.net' }))).resolves.toEqual({
        externalMessageId: 'MSG-1',
      });
      expect(sendText).toHaveBeenCalledWith('a@s.whatsapp.net', 'On my way', 40_000);
    } finally {
      unregister();
    }
  });

  it('an account whose session was logged out asks to reconnect, not to retry — until it pulls again', async () => {
    markLoggedOut('acc-lo');
    const s = createWhatsAppSender();
    const i = { ...intent({ jid: 'a@s.whatsapp.net' }), accountId: 'acc-lo' as never };
    await expect(s.send(i)).rejects.toThrow(/reconnect the account in Settings$/);
    const unregister = registerLive('acc-lo', { sendText: async () => 'M' });
    unregister();
    await expect(s.send(i)).rejects.toThrow(/^not sent: /);
  });

  it('no live connection or no target → "not sent"', async () => {
    await expect(createWhatsAppSender().send(intent({ jid: 'a@s.whatsapp.net' }))).rejects.toThrow(/^not sent: /);
    const unregister = registerLive('acc-s', { sendText: jest.fn() });
    try {
      await expect(createWhatsAppSender().send(intent({ jid: 'status@broadcast' }))).rejects.toThrow(/^not sent: /);
    } finally {
      unregister();
    }
  });
});
