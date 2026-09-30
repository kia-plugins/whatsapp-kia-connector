import type { ExtensionModule } from '@kiagent/connector-sdk';
import { createWhatsAppSender } from './sender';
import { createWhatsAppSource } from './source';

const mod = {
  async activate(host) {
    return {
      sources: [createWhatsAppSource(host)],
      senders: { whatsapp: createWhatsAppSender() },
    };
  },
} satisfies ExtensionModule<'net' | 'query' | 'send'>;

export default mod;
module.exports = mod; // dual export — the host child require()s CJS
