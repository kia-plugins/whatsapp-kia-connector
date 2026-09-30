/**
 * The one live runtime per account, for the Sender. A WhatsApp linked device
 * has ONE connection: a second socket on the same credentials replaces the
 * first, so a send must go through the socket pull() already holds.
 *
 * Owned per registration: an old pull's late cleanup (a restart registers
 * the new runtime before the old one has finished stopping) removes only
 * its own entry, never its replacement.
 */
export interface LiveRuntime {
  sendText(jid: string, text: string, deadlineMs: number): Promise<string>;
}

const live = new Map<string, LiveRuntime>();
/** Accounts whose last pull ended logged out: a send needs re-pairing, not
 *  a retry. Cleared when a pull registers again. */
const loggedOut = new Set<string>();

export function registerLive(accountId: string, runtime: LiveRuntime): () => void {
  live.set(accountId, runtime);
  loggedOut.delete(accountId);
  return () => {
    if (live.get(accountId) === runtime) live.delete(accountId);
  };
}

export function liveRuntime(accountId: string): LiveRuntime | undefined {
  return live.get(accountId);
}

export function markLoggedOut(accountId: string): void {
  loggedOut.add(accountId);
}

export function isLoggedOut(accountId: string): boolean {
  return loggedOut.has(accountId);
}
