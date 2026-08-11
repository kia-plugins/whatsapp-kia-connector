/**
 * The WhatsApp protocol version handed to Baileys, and why it needs its own
 * module.
 *
 * `makeWASocket` merges `{...DEFAULT_CONNECTION_CONFIG, ...config}`, so passing
 * `version: undefined` OVERWRITES Baileys' baked-in default instead of falling
 * back to it — `getUserAgent` then throws `Cannot read properties of undefined
 * (reading '0')` on `config.version[0]`, before a login node can even be built.
 * And `fetchLatestBaileysVersion` never rejects and never validates: a network
 * failure silently yields Baileys' own bundled version, and a captive portal
 * answering 200 HTML yields `undefined` with `isLatest: true`.
 *
 * Both shipped as multi-hour outages on a user's machine — 2026-08-10: 13h of
 * `Connection Failure` because WhatsApp rejected the stale bundled version;
 * 2026-08-11: 4.6h of the TypeError above. Both began with an app boot while
 * DNS was down, and both LASTED because the version is resolved once per
 * session and the reconnect loop reuses that captured value forever.
 *
 * Hence the three rules here: only accept a well-formed triple, remember the
 * last version WhatsApp actually accepted, and let a long-lived session pick up
 * a fresh one without waiting for the engine to open a new session.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { LogLevel } from '@kiagent/connector-sdk';

export type WaVersion = [number, number, number];

export type VersionLog = (level: LogLevel, msg: string) => void;

/** Default staleness window before `current()` kicks a background re-fetch. */
export const VERSION_REFRESH_MS = 10 * 60_000;

/** Default cap on the version fetch — Baileys' own has no timeout at all. */
export const VERSION_FETCH_TIMEOUT_MS = 3000;

/**
 * The ONLY shape `makeWASocket` can consume. `fetchLatestBaileysVersion`
 * promises `[number, number, number]` but delivers whatever the response body
 * parsed to, so this guard is load-bearing, not defensive decoration.
 */
export function isWaVersion(v: unknown): v is WaVersion {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

export function formatVersion(v: WaVersion | undefined): string {
  return v ? v.join('.') : 'none';
}

/** Last-known-good storage. Injectable so tests never touch the filesystem. */
export interface VersionCache {
  read(): WaVersion | undefined;
  write(version: WaVersion): void;
}

/**
 * JSON file under the extension's dataDir. Every failure is swallowed: this is
 * an optimization, and a connect must never fail because a cache file is
 * unreadable.
 */
export function fileVersionCache(file: string): VersionCache {
  return {
    read() {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          version?: unknown;
        };
        return isWaVersion(raw.version) ? raw.version : undefined;
      } catch {
        return undefined;
      }
    },
    write(version) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          JSON.stringify({ version, savedAt: new Date().toISOString() }),
        );
      } catch {
        /* cache-only — never surface */
      }
    },
  };
}

export interface VersionResolverDeps {
  cache: VersionCache;
  /** Normally `fetchLatestBaileysVersion().then((r) => r.version)`. */
  fetchVersion: () => Promise<unknown>;
  fetchTimeoutMs?: number;
  refreshAfterMs?: number;
  now?: () => number;
}

/**
 * Resolves the version once per session (awaited), then hands it out
 * synchronously to every reconnect while refreshing in the background.
 */
export class VersionResolver {
  private version?: WaVersion;

  /** Where `version` came from — reported verbatim, so a log line saying
   *  "fetched" always means a fetch actually replaced it. */
  private origin: 'fetched' | 'cached' | 'none' = 'none';

  /** 0 means "never resolved" — `init()` always does real work the first time. */
  private resolvedAt = 0;

  /** In-flight refresh, shared: a second account starting up mid-fetch must
   *  AWAIT that fetch, not skip past it and report "no version available". */
  private inFlight?: Promise<void>;

  private lastWritten?: string;

  private log?: VersionLog;

  private readonly now: () => number;

  private readonly fetchTimeoutMs: number;

  private readonly refreshAfterMs: number;

  constructor(private readonly deps: VersionResolverDeps) {
    this.now = deps.now ?? Date.now;
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? VERSION_FETCH_TIMEOUT_MS;
    this.refreshAfterMs = deps.refreshAfterMs ?? VERSION_REFRESH_MS;
  }

  /**
   * Resolve before the first socket is built. Cheap on a warm resolver: a
   * second session inside the refresh window reuses what's already here rather
   * than re-fetching per account.
   */
  async init(log?: VersionLog): Promise<void> {
    if (log) this.log = log;

    if (!this.version || this.isStale()) {
      await this.refresh();
      if (!this.version) {
        const cached = this.deps.cache.read();
        if (cached) {
          this.version = cached;
          this.origin = 'cached';
          // Already on disk — noteAccepted must not rewrite it.
          this.lastWritten = formatVersion(cached);
        }
      }
    }
    // Reported on EVERY init, warm path included: each account's session log
    // should say which version that session is about to use.
    this.report();
  }

  /**
   * Sync accessor for the reconnect path. Kicks a background refresh once the
   * value goes stale so a session that opened during a network outage can heal
   * without waiting for the engine to start a new one.
   */
  current(): WaVersion | undefined {
    if (this.isStale()) {
      // Stamp BEFORE awaiting so a failing refresh can't turn every reconnect
      // into a fetch — the reconnect loop runs every 30s at its cap.
      this.resolvedAt = this.now();
      void this.refresh();
    }
    return this.version;
  }

  /**
   * Called when a socket reaches `connection: 'open'` — the only trustworthy
   * evidence that WhatsApp still accepts this version. Persisted so a later
   * boot with no network has something better than Baileys' bundled default.
   */
  noteAccepted(version: WaVersion | undefined): void {
    if (!version) return;
    const key = formatVersion(version);
    if (key === this.lastWritten) return;
    this.lastWritten = key;
    this.deps.cache.write(version);
  }

  private report(): void {
    const v = formatVersion(this.version);
    if (this.origin === 'fetched') {
      this.log?.('info', `whatsapp: protocol version ${v} (fetched)`);
    } else if (this.origin === 'cached') {
      this.log?.(
        'warn',
        `whatsapp: version fetch unavailable — using last accepted version ${v}`,
      );
    } else {
      // Nothing usable. The socket factory omits the key entirely so Baileys
      // falls back to its own bundled version, which is the best guess left —
      // and the one WhatsApp rejected outright on 2026-08-10, so say so.
      this.log?.(
        'warn',
        'whatsapp: no protocol version available (fetch failed, no cached version) — falling back to the version bundled with Baileys',
      );
    }
  }

  private isStale(): boolean {
    return this.now() - this.resolvedAt >= this.refreshAfterMs;
  }

  private refresh(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.fetchOnce().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** Replaces the current version ONLY on a well-formed fetch — a failed
   *  refresh must never downgrade a version that is working right now. */
  private async fetchOnce(): Promise<void> {
    const fetched = await Promise.race([
      this.deps.fetchVersion().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        const t = setTimeout(() => resolve(undefined), this.fetchTimeoutMs);
        t.unref?.();
      }),
    ]);
    this.resolvedAt = this.now();
    if (!isWaVersion(fetched)) return;
    const previous = this.version;
    this.version = fetched;
    this.origin = 'fetched';
    if (previous && formatVersion(previous) !== formatVersion(fetched)) {
      this.log?.(
        'info',
        `whatsapp: protocol version ${formatVersion(previous)} → ${formatVersion(fetched)}`,
      );
    }
  }
}
