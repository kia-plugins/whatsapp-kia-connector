import { EventEmitter } from 'node:events';
import { WhatsAppSocket } from '../socket';

function fakeBaileys() {
  const ev = new EventEmitter();
  const sock = {
    ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) },
    end: jest.fn(),
    ws: { close: jest.fn() },
  };
  return { sock, ev, factory: () => sock as any };
}

/**
 * Factory that mirrors real Baileys: a FRESH EventEmitter per call. Counts how
 * many times it was invoked (each call === one (re)connect) and exposes the
 * latest emitter so the test can drive `connection.update` on it.
 */
function countingBaileys() {
  const state = { calls: 0, ev: undefined as EventEmitter | undefined };
  const factory = () => {
    state.calls += 1;
    const ev = new EventEmitter();
    state.ev = ev;
    return {
      ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) },
      end: jest.fn(),
      ws: { close: jest.fn() },
    } as any;
  };
  return { state, factory };
}

describe('WhatsAppSocket', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits qr then connected on the connection lifecycle', async () => {
    const { ev, factory } = fakeBaileys();
    const events: string[] = [];
    const s = new WhatsAppSocket({
      makeSocket: factory,
      onQr: () => events.push('qr'),
      onConnected: () => events.push('open'),
      onLoggedOut: () => events.push('out'),
      onMessages: () => {},
      onHistory: () => {},
    });
    await s.start();
    ev.emit('connection.update', { qr: 'QR123' });
    ev.emit('connection.update', { connection: 'open' });
    expect(events).toEqual(['qr', 'open']);
  });

  it('forwards creds.update to onCredsUpdate (key rotation persistence)', async () => {
    const { ev, factory } = fakeBaileys();
    let saves = 0;
    const s = new WhatsAppSocket({
      makeSocket: factory,
      onQr: () => {},
      onConnected: () => {},
      onLoggedOut: () => {},
      onCredsUpdate: () => {
        saves += 1;
      },
      onMessages: () => {},
      onHistory: () => {},
    });
    await s.start();
    ev.emit('creds.update', {});
    ev.emit('creds.update', {});
    expect(saves).toBe(2);
  });

  it('signals logged-out on a 401 close and schedules no reconnect', async () => {
    jest.useFakeTimers();
    const { state, factory } = countingBaileys();
    const events: string[] = [];
    const s = new WhatsAppSocket({
      makeSocket: factory,
      reconnectBaseMs: 1000,
      reconnectCapMs: 30000,
      onQr: () => {},
      onConnected: () => {},
      onLoggedOut: () => events.push('out'),
      onMessages: () => {},
      onHistory: () => {},
    });
    await s.start();
    state.ev!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(events).toEqual(['out']);
    // loggedOut is terminal: nothing should be queued to reconnect.
    jest.advanceTimersByTime(60000);
    expect(state.calls).toBe(1);
  });

  it('schedules a backed-off reconnect on a transient close', async () => {
    jest.useFakeTimers();
    const { state, factory } = countingBaileys();
    const s = new WhatsAppSocket({
      makeSocket: factory,
      reconnectBaseMs: 1000,
      reconnectCapMs: 30000,
      onQr: () => {},
      onConnected: () => {},
      onLoggedOut: () => {},
      onMessages: () => {},
      onHistory: () => {},
    });
    await s.start();
    expect(state.calls).toBe(1);
    // Transient close: a plain Error has no statusCode.
    state.ev!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Error('boom') },
    });
    // Reconnect is scheduled, not immediate — no extra factory call yet.
    expect(state.calls).toBe(1);
    jest.advanceTimersByTime(2000);
    // The backoff timer fired and made a fresh socket.
    expect(state.calls).toBe(2);
  });

  it('logs and reschedules when a reconnect attempt itself throws (no silent zombie)', async () => {
    // Real timers with tiny backoff: attempt 2 throws inside start(), the
    // catch must reschedule so attempt 3 still happens.
    let calls = 0;
    let latest: EventEmitter | undefined;
    const factory = () => {
      calls += 1;
      if (calls === 2) throw new Error('dns down');
      const ev = new EventEmitter();
      latest = ev;
      return {
        ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) },
        end: jest.fn(),
        ws: { close: jest.fn() },
      } as any;
    };
    const logs: string[] = [];
    const s = new WhatsAppSocket({
      makeSocket: factory,
      reconnectBaseMs: 1,
      reconnectCapMs: 4,
      onLog: (_level, msg) => logs.push(msg),
      onQr: () => {},
      onConnected: () => {},
      onLoggedOut: () => {},
      onMessages: () => {},
      onHistory: () => {},
    });
    await s.start();
    expect(calls).toBe(1);
    latest!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Error('boom') },
    });
    // attempt 2 fires and throws; the reschedule must produce attempt 3.
    const deadline = Date.now() + 1000;
    while (calls < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(logs.some((m) => /reconnect failed/.test(m))).toBe(true);
    await s.stop();
  });

  it('stop() cancels a pending reconnect', async () => {
    jest.useFakeTimers();
    const { state, factory } = countingBaileys();
    const s = new WhatsAppSocket({
      makeSocket: factory,
      reconnectBaseMs: 1000,
      reconnectCapMs: 30000,
      onQr: () => {},
      onConnected: () => {},
      onLoggedOut: () => {},
      onMessages: () => {},
      onHistory: () => {},
    });
    await s.start();
    state.ev!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Error('boom') },
    });
    expect(state.calls).toBe(1);
    await s.stop();
    jest.advanceTimersByTime(60000);
    // The queued reconnect was cancelled by stop().
    expect(state.calls).toBe(1);
  });
});
