/**
 * WhatsApp Sender — posts a reply into the chat a day document came from.
 * Reachable only from kiagent-core's confirmation-gated send pipeline; the
 * target is the opaque `metadata.outbound` ref toDocument wrote
 * (outbound.ts), never a model-supplied jid.
 *
 * Sends through the account's LIVE socket (live.ts) and reports success
 * only on the server's acknowledgement (socket.ts sendText). Failure wording
 * is a cross-repo contract with kiagent-core's error-copy.ts: `not sent:`
 * proves nothing left; anything else reads "may have been sent".
 */
import type { SendIntent, SendResult, Sender } from '@kiagent/connector-sdk';

import { isLoggedOut, liveRuntime } from './live';
import { parseOutboundRef } from './outbound';
import { NOT_CONNECTED } from './socket';

/** Well inside kiagent-core's 60 s sender timeout (which does not cancel). */
export const SEND_DEADLINE_MS = 40_000;

export function createWhatsAppSender(opts: { deadlineMs?: number } = {}): Sender {
  const deadlineMs = opts.deadlineMs ?? SEND_DEADLINE_MS;
  return {
    async send(intent: SendIntent): Promise<SendResult> {
      const ref = parseOutboundRef(intent.outboundRef);
      if (!ref) throw new Error('not sent: this draft has no WhatsApp chat to reply to');
      const runtime = liveRuntime(intent.accountId);
      if (!runtime) {
        if (isLoggedOut(intent.accountId))
          throw new Error('your WhatsApp session is gone — reconnect the account in Settings');
        throw new Error(NOT_CONNECTED);
      }
      const id = await runtime.sendText(ref.jid, intent.bodyMarkdown, deadlineMs);
      return { externalMessageId: id };
    },
  };
}
