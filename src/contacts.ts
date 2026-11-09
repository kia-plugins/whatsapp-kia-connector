/**
 * Normalize a device-qualified JID to its bare phone-user form:
 * '4917012345:13@s.whatsapp.net' → '4917012345@s.whatsapp.net'.
 * Used both for the account identifier (re-pairing the same phone must yield
 * the same identifier so the platform upserts the SAME account) and for
 * self-JID comparison in the contact book.
 */
export function normalizeJid(jid: string): string {
  const [user, host = 's.whatsapp.net'] = jid.split('@');
  return `${user.split(':')[0]}@${host}`;
}

/** The display string `ContactBook.name` falls back to for a JID it has no
 *  name for: '+<digits>' for phone/LID users, else the bare user part. */
export function fallbackName(jid: string): string {
  const user = jid.split('@')[0]?.split(':')[0] ?? jid;
  return /^\d+$/.test(user) ? `+${user}` : user;
}

/** True for a display string that is only a number — what a sender or chat
 *  name degrades to when no real name was known when it was rendered. */
export function isFallbackName(name: unknown): boolean {
  return typeof name !== 'string' || name.trim() === '' || /^\+?\d+$/.test(name.trim());
}

/** Serialized form persisted between runs (contacts.json). */
export interface ContactBookSnapshot {
  names: Record<string, string>;
  aliases: Array<[string, string]>;
}

/**
 * Resolves WhatsApp JIDs to display names; mutated as names arrive.
 *
 * WhatsApp addresses one person by two ids — the phone JID
 * (`<n>@s.whatsapp.net`) and a LID (`<n>@lid`) — and a name often arrives
 * under one while the chat is keyed by the other (history-sync contacts and
 * push names come keyed by phone, many chats by LID). `alias` links the two
 * so a name known under either resolves for both.
 */
export class ContactBook {
  private names = new Map<string, string>();

  /** jid → the other id of the same person (both directions). */
  private aliases = new Map<string, string>();

  /** Called with every jid whose resolved name just changed. */
  onLearn?: (jids: string[]) => void;

  constructor(private readonly selfJid: string) {}

  private key(jid: string): string {
    return jid.includes('@') ? normalizeJid(jid) : jid;
  }

  /** Every id (the jid and its alias) this name applies to. */
  private group(jid: string): string[] {
    const k = this.key(jid);
    const other = this.aliases.get(k);
    return other ? [k, other] : [k];
  }

  /** Record a real name. Numbers-only names are ignored: they carry nothing
   *  the fallback doesn't, and must never displace a real name. */
  set(jid: string | undefined | null, name: string | undefined | null): void {
    if (!jid || !name || isFallbackName(name)) return;
    const k = this.key(jid);
    const trimmed = name.trim();
    if (this.names.get(k) === trimmed) return;
    const before = this.known(k);
    this.names.set(k, trimmed);
    if (this.known(k) !== before) this.onLearn?.(this.group(k));
  }

  /** Link the phone JID and the LID of one person. */
  alias(a: string | undefined | null, b: string | undefined | null): void {
    if (!a || !b) return;
    const ka = this.key(a);
    const kb = this.key(b);
    if (ka === kb || this.aliases.get(ka) === kb) return;
    const beforeA = this.known(ka);
    const beforeB = this.known(kb);
    this.aliases.set(ka, kb);
    this.aliases.set(kb, ka);
    const changed: string[] = [];
    if (this.known(ka) !== beforeA) changed.push(ka);
    if (this.known(kb) !== beforeB) changed.push(kb);
    if (changed.length) this.onLearn?.(changed);
  }

  /** The real name for a jid (directly or via its alias); null when only the
   *  number fallback is available. */
  known(jid: string | undefined | null): string | null {
    if (!jid) return null;
    const k = this.key(jid);
    if (k === this.selfJid) return 'You';
    const direct = this.names.get(k);
    if (direct) return direct;
    const other = this.aliases.get(k);
    return (other && this.names.get(other)) || null;
  }

  name(jid: string | undefined | null): string | null {
    if (!jid) return null;
    return this.known(jid) ?? fallbackName(jid);
  }

  snapshot(): ContactBookSnapshot {
    const aliases: Array<[string, string]> = [];
    for (const [a, b] of this.aliases) if (a < b) aliases.push([a, b]);
    return { names: Object.fromEntries(this.names), aliases };
  }

  /** Load a persisted snapshot without firing onLearn (nothing is rendered
   *  yet when it runs). Malformed entries are skipped. */
  restore(snap: unknown): void {
    const s = snap as Partial<ContactBookSnapshot> | null | undefined;
    if (s?.names && typeof s.names === 'object') {
      for (const [jid, name] of Object.entries(s.names)) {
        if (typeof name === 'string' && !isFallbackName(name)) this.names.set(jid, name);
      }
    }
    if (Array.isArray(s?.aliases)) {
      for (const pair of s!.aliases) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
          this.aliases.set(pair[0], pair[1]);
          this.aliases.set(pair[1], pair[0]);
        }
      }
    }
  }
}
