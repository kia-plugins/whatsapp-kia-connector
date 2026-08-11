import {
  fileVersionCache,
  isWaVersion,
  VersionResolver,
  type VersionCache,
  type WaVersion,
} from '../version';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GOOD: WaVersion = [2, 3000, 1043857760];
const OTHER: WaVersion = [2, 3000, 1099999999];

function memCache(seed?: WaVersion): VersionCache & { writes: WaVersion[] } {
  let held = seed;
  const writes: WaVersion[] = [];
  return {
    writes,
    read: () => held,
    write: (v) => {
      held = v;
      writes.push(v);
    },
  };
}

/** Let the fire-and-forget background refresh settle. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Manual clock so staleness is asserted, not slept through. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('isWaVersion', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a two-element array', [2, 3000]],
    ['a string triple', ['2', '3000', '1']],
    ['a parsed HTML body (captive portal)', { html: '<!doctype html>' }],
    ['NaN in the triple', [2, 3000, Number.NaN]],
  ])('rejects %s', (_label, value) => {
    expect(isWaVersion(value)).toBe(false);
  });

  it('accepts a numeric triple', () => {
    expect(isWaVersion([2, 3000, 1043857760])).toBe(true);
  });
});

describe('VersionResolver.init', () => {
  it('uses a well-formed fetched version', async () => {
    const r = new VersionResolver({
      cache: memCache(),
      fetchVersion: async () => GOOD,
    });
    await r.init();
    expect(r.current()).toEqual(GOOD);
  });

  it('falls back to the cached version when the fetch rejects', async () => {
    const logs: string[] = [];
    const r = new VersionResolver({
      cache: memCache(GOOD),
      fetchVersion: async () => {
        throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
      },
    });
    await r.init((_l, m) => logs.push(m));
    expect(r.current()).toEqual(GOOD);
    expect(logs.join('\n')).toContain('last accepted version 2.3000.1043857760');
  });

  it('falls back to the cached version when the fetch resolves a non-triple', async () => {
    // The captive-portal case: fetchLatestBaileysVersion resolves 200 HTML, so
    // `.version` is undefined and nothing ever threw for `.catch` to see.
    const r = new VersionResolver({
      cache: memCache(GOOD),
      fetchVersion: async () => undefined,
    });
    await r.init();
    expect(r.current()).toEqual(GOOD);
  });

  it('falls back to the cached version when the fetch outlives its timeout', async () => {
    const r = new VersionResolver({
      cache: memCache(GOOD),
      fetchVersion: () =>
        new Promise((resolve) => setTimeout(() => resolve(OTHER), 50)),
      fetchTimeoutMs: 1,
    });
    await r.init();
    expect(r.current()).toEqual(GOOD);
  });

  it('yields no version — and says so — when the fetch fails with an empty cache', async () => {
    const logs: string[] = [];
    const r = new VersionResolver({
      cache: memCache(),
      fetchVersion: async () => undefined,
    });
    await r.init((_l, m) => logs.push(m));
    expect(r.current()).toBeUndefined();
    expect(logs.join('\n')).toContain('no protocol version available');
  });

  it('reports the version on the warm path too, with its true provenance', async () => {
    // A second account starting inside the refresh window still logs which
    // version its session will use — and says "cached" when that is the truth.
    const logs: string[] = [];
    const r = new VersionResolver({
      cache: memCache(GOOD),
      fetchVersion: async () => undefined,
      refreshAfterMs: 10_000,
      now: clock().now,
    });
    await r.init((_l, m) => logs.push(m));
    await r.init((_l, m) => logs.push(m));
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('last accepted version 2.3000.1043857760');
    expect(logs[1]).not.toContain('no protocol version available');
  });

  it('makes a concurrent init await the in-flight fetch, not skip it', async () => {
    // Two accounts starting together: the second must not race past the first
    // account's fetch and report "no version available".
    const fetchVersion = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(GOOD), 20)),
    );
    const logs: string[] = [];
    const r = new VersionResolver({ cache: memCache(), fetchVersion });

    await Promise.all([
      r.init((_l, m) => logs.push(m)),
      r.init((_l, m) => logs.push(m)),
    ]);

    expect(fetchVersion).toHaveBeenCalledTimes(1);
    expect(r.current()).toEqual(GOOD);
    expect(logs.join('\n')).not.toContain('no protocol version available');
  });

  it('does not re-fetch inside the refresh window', async () => {
    const fetchVersion = jest.fn(async () => GOOD);
    const c = clock();
    const r = new VersionResolver({
      cache: memCache(),
      fetchVersion,
      now: c.now,
      refreshAfterMs: 10_000,
    });
    await r.init();
    await r.init();
    expect(fetchVersion).toHaveBeenCalledTimes(1);

    c.advance(10_000);
    await r.init();
    expect(fetchVersion).toHaveBeenCalledTimes(2);
  });
});

describe('VersionResolver.current', () => {
  it('picks up a new version on a background refresh once stale', async () => {
    let served: WaVersion = GOOD;
    const c = clock();
    const r = new VersionResolver({
      cache: memCache(),
      fetchVersion: async () => served,
      now: c.now,
      refreshAfterMs: 10_000,
    });
    await r.init();
    expect(r.current()).toEqual(GOOD);

    served = OTHER;
    c.advance(5000);
    expect(r.current()).toEqual(GOOD); // still fresh — no refetch

    c.advance(5000);
    r.current(); // stale: kicks the background refresh
    await flush();
    expect(r.current()).toEqual(OTHER);
  });

  it('keeps a working version when a refresh fails', async () => {
    let fail = false;
    const c = clock();
    const r = new VersionResolver({
      cache: memCache(),
      fetchVersion: async () => {
        if (fail) throw new Error('offline');
        return GOOD;
      },
      now: c.now,
      refreshAfterMs: 10_000,
    });
    await r.init();

    fail = true;
    c.advance(10_000);
    r.current();
    await flush();
    // A failed refresh must never downgrade the version that is working now.
    expect(r.current()).toEqual(GOOD);
  });
});

describe('VersionResolver.noteAccepted', () => {
  it('persists a version once, and only when it changes', async () => {
    const cache = memCache();
    const r = new VersionResolver({ cache, fetchVersion: async () => GOOD });
    await r.init();

    r.noteAccepted(GOOD);
    r.noteAccepted(GOOD);
    expect(cache.writes).toEqual([GOOD]);

    r.noteAccepted(OTHER);
    expect(cache.writes).toEqual([GOOD, OTHER]);
  });

  it('ignores an absent version', () => {
    const cache = memCache();
    const r = new VersionResolver({ cache, fetchVersion: async () => GOOD });
    r.noteAccepted(undefined);
    expect(cache.writes).toEqual([]);
  });

  it('does not re-write a version that came from the cache', async () => {
    const cache = memCache(GOOD);
    const r = new VersionResolver({
      cache,
      fetchVersion: async () => undefined,
    });
    await r.init();
    r.noteAccepted(GOOD);
    expect(cache.writes).toEqual([]);
  });
});

describe('fileVersionCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-version-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a version through a nested path', () => {
    const c = fileVersionCache(path.join(dir, 'nested', 'wa-version.json'));
    expect(c.read()).toBeUndefined();
    c.write(GOOD);
    expect(c.read()).toEqual(GOOD);
  });

  it('reads undefined from a corrupt or malformed file rather than throwing', () => {
    const file = path.join(dir, 'wa-version.json');
    fs.writeFileSync(file, 'not json');
    expect(fileVersionCache(file).read()).toBeUndefined();

    fs.writeFileSync(file, JSON.stringify({ version: 'nope' }));
    expect(fileVersionCache(file).read()).toBeUndefined();
  });

  it('swallows an unwritable path', () => {
    // A directory where the file should be: writeFileSync throws EISDIR.
    const file = path.join(dir, 'wa-version.json');
    fs.mkdirSync(file);
    expect(() => fileVersionCache(file).write(GOOD)).not.toThrow();
  });
});
