/**
 * Regression cover for the two shipped WhatsApp outages (see version.ts):
 * a `version: undefined` reaching makeWASocket, and a fetch failure falling
 * through to Baileys' stale bundled version instead of the last one WhatsApp
 * accepted.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('@whiskeysockets/baileys', () => ({
  ...jest.requireActual('@whiskeysockets/baileys'),
  __esModule: true,
  default: jest.fn(),
  fetchLatestBaileysVersion: jest.fn(),
}));

import makeWASocket, {
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import type { AuthenticationState } from '@whiskeysockets/baileys';

import { createDefaultSocketFactory, VERSION_CACHE_FILE } from '../source';

const mockMake = makeWASocket as unknown as jest.Mock;
const mockFetch = fetchLatestBaileysVersion as unknown as jest.Mock;

const GOOD = [2, 3000, 1043857760];
const AUTH = {} as AuthenticationState;

/** A socket whose `connection.update` the test can drive. */
function fakeSocket(): { sock: unknown; ev: EventEmitter } {
  const ev = new EventEmitter();
  return { sock: { ev: { on: ev.on.bind(ev), off: ev.off.bind(ev) } }, ev };
}

/** The config object handed to the Nth makeWASocket call. */
function configOf(call = 0): Record<string, unknown> {
  return mockMake.mock.calls[call][0] as Record<string, unknown>;
}

describe('createDefaultSocketFactory', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-factory-'));
    mockMake.mockReset();
    mockFetch.mockReset();
    mockMake.mockImplementation(() => fakeSocket().sock);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a fetched version straight through', async () => {
    mockFetch.mockResolvedValue({ version: GOOD });

    const make = await createDefaultSocketFactory(dir)(AUTH);
    make();

    expect(configOf().version).toEqual(GOOD);
  });

  it('OMITS the version key when there is nothing to send', async () => {
    // The Aug-11 outage: `version: undefined` does NOT fall back to Baileys'
    // default — makeWASocket spreads it over DEFAULT_CONNECTION_CONFIG, so the
    // key must be absent, not present-and-undefined. An assertion of
    // `version === undefined` passes on the buggy code; `in` does not.
    mockFetch.mockResolvedValue({ version: undefined });

    const make = await createDefaultSocketFactory(dir)(AUTH);
    make();

    expect('version' in configOf()).toBe(false);
  });

  it('omits the version key when the fetch rejects and nothing is cached', async () => {
    mockFetch.mockRejectedValue(new Error('ENOTFOUND'));

    const make = await createDefaultSocketFactory(dir)(AUTH);
    make();

    expect('version' in configOf()).toBe(false);
  });

  it('caches the version once a connection opens, and reuses it when offline', async () => {
    mockFetch.mockResolvedValue({ version: GOOD });
    const opened = fakeSocket();
    mockMake.mockImplementation(() => opened.sock);

    const make = await createDefaultSocketFactory(dir)(AUTH);
    make();
    opened.ev.emit('connection.update', { connection: 'open' });

    expect(
      JSON.parse(fs.readFileSync(path.join(dir, VERSION_CACHE_FILE), 'utf8'))
        .version,
    ).toEqual(GOOD);

    // A later boot with no network: the last ACCEPTED version, not Baileys'
    // bundled one (which is what WhatsApp rejected for 13h on 2026-08-10).
    mockMake.mockReset();
    mockMake.mockImplementation(() => fakeSocket().sock);
    mockFetch.mockRejectedValue(new Error('ENOTFOUND'));

    const offline = await createDefaultSocketFactory(dir)(AUTH);
    offline();

    expect(configOf().version).toEqual(GOOD);
  });

  it('does not cache a version that never opened a connection', async () => {
    mockFetch.mockResolvedValue({ version: GOOD });

    const make = await createDefaultSocketFactory(dir)(AUTH);
    make(); // connects, then dies without ever reaching 'open'

    expect(fs.existsSync(path.join(dir, VERSION_CACHE_FILE))).toBe(false);
  });

  it('reports the version it resolved to the session log', async () => {
    mockFetch.mockResolvedValue({ version: GOOD });
    const logs: string[] = [];

    await createDefaultSocketFactory(dir)(AUTH, (_l, m) => logs.push(m));

    expect(logs.join('\n')).toContain('2.3000.1043857760');
  });
});
