// dayKey/dayTitle/mergeMessages/renderDay now live in the SDK's chat-day
// module (verbatim port of this repo's former implementation — see
// @kiagent/connector-sdk/chat-day). Re-exported here, alongside the one
// piece that stays repo-owned (DOC_TYPE), so the rest of the repo keeps
// importing from './chat-day'.
export const DOC_TYPE = 'whatsapp.chat_day';

export { dayKey, dayTitle, mergeMessages, renderDay } from '@kiagent/connector-sdk/chat-day';
