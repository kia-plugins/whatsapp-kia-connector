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

/** Resolves WhatsApp JIDs to display names; mutated as contacts.update arrives. */
export class ContactBook {
  private names = new Map<string, string>();

  constructor(private readonly selfJid: string) {}

  set(jid: string, name: string | undefined | null): void {
    if (name && name.trim()) this.names.set(jid, name.trim());
  }

  name(jid: string | undefined | null): string | null {
    if (!jid) return null;
    if (jid === this.selfJid) return 'You';
    const known = this.names.get(jid);
    if (known) return known;
    // '49170123@s.whatsapp.net' → '+49170123'
    const phone = jid.split('@')[0]?.split(':')[0] ?? jid;
    return /^\d+$/.test(phone) ? `+${phone}` : phone;
  }
}
