# WhatsApp connector for KIAgent

An **unofficial** WhatsApp connector for KIAgent (v2 extension platform). It
links your WhatsApp number as a companion device through the
[Baileys](https://github.com/WhiskeySockets/Baileys) library and ingests your
chats — one searchable document per chat per day, plus downloaded media — into
your local KIAgent digital memory.

## ⚠️ Ban risk (read this first)

This connector is **unofficial**. WhatsApp provides no public client API, so
Baileys links your number as a companion device by reverse-engineering the
WhatsApp Web protocol. **Using it may get your WhatsApp number temporarily or
permanently banned.** There is no warranty (see `LICENSE`). The connector
keeps its traffic deliberately gentle — one socket per account, spaced
reconnects, media downloaded one file at a time — which reduces, but does not
eliminate, the risk. Link a number you can afford to lose. Use at your own
risk.

Each connected account occupies one of your WhatsApp **linked devices** slots.

## Install

Install **WhatsApp** from the KIAgent marketplace (Settings → Extensions →
Marketplace → WhatsApp → Install). KIAgent prompts for the two grants this
connector needs before it activates:

- `net` — the connector talks to WhatsApp's servers over Baileys' own
  websocket.
- `query` — it re-reads its own previously-ingested chat-day documents so a
  restart can merge new messages into existing days (WhatsApp does not
  re-deliver old history).

## Connect your account

1. Add a WhatsApp account in KIAgent. A QR code appears (and refreshes every
   few seconds — keep the dialog open).
2. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device**,
   then scan the QR.
3. That's it. The account identifier is your phone's WhatsApp JID
   (`<number>@s.whatsapp.net`). Pairing times out after ~3 minutes — just try
   again. Re-pairing the same number later reuses the same account and simply
   refreshes its credentials.

## What gets indexed

- **One document per chat per (local) day** — type `whatsapp.chat_day`,
  externalId `<chatJid>:<YYYY-MM-DD>` — with every message rendered as
  `HH:MM Sender: text`, reply quotes inline (`↳re …`), media as labels
  (`[image]`, `[voice note 1:05]`, `[document: invoice.pdf]`), and system
  notices in italics. Contact and group names resolve from your address book
  sync and push names; unknown senders fall back to `+<phone>`.
- **Media files** (images, video, audio, documents, stickers) up to **25 MiB**
  download in the background — one at a time, to stay gentle — and land as
  `file` documents parented under their chat-day, with the bytes handed to the
  platform's converters/OCR.
- History: opening the socket streams WhatsApp's full history sync (that is
  the backfill); afterwards live messages arrive in realtime over the same
  long-lived socket.

Known gaps (kept from v1 for parity): message edits/revokes are not tracked,
reactions are not indexed, stories/status broadcasts are skipped.

## Privacy notes

- Everything stays local: chat content flows from WhatsApp's servers over
  Baileys' websocket straight into your local KIAgent index. The connector has
  no server of its own and no analytics.
- **Session credentials are stored unencrypted.** The Baileys auth blob
  (your linked-device session keys) is written in plaintext — file mode 0600,
  atomic writes — under the extension's private data directory
  (`auth/<account>.bin`). The v1 connector encrypted this blob with the OS
  keychain (Electron safeStorage); the v2 extension host does not expose a
  keychain surface yet, so that protection is currently **absent**. Anyone
  with read access to your user profile could copy the blob and use your
  WhatsApp session. The encryption seam is still in the code, so a future
  platform vault can re-enable it without a re-pair. If this matters for your
  threat model, do not connect WhatsApp yet.
- Unlinking the device from your phone (or removing the account in KIAgent)
  invalidates the session; the connector then reports the account as needing
  a reconnect.

## Changes from the v1 connector

- **Chat-export import is gone.** The v1 offline `.zip`/`.txt` chat-export
  importer (and its adm-zip/whatsapp-chat-parser dependencies) is out of
  scope for v2.
- **No `[Attachment](doc://…)` links.** v2 sources never see database ids, so
  day documents show a media label only; the downloaded file is reachable as
  the child `file` document of that day.
- **No local media cache directory.** Bytes ride the ingest batch; the engine
  owns storage and cleanup.

## Build from source

```bash
npm install        # first run builds Baileys — takes a minute
npm test           # jest: all offline, socket behavior driven via a fake
npm run typecheck  # tsc --noEmit
npm run build      # esbuild → dist/index.js (self-contained CJS, ~6 MB)
npm pack           # → whatsapp-kia-connector-<version>.tgz
```

The four optional native media deps Baileys can lazy-load (`sharp`, `jimp`,
`link-preview-js`, `audio-decode`) are externalized from the bundle — the
buffer-download path used here never needs them, and the `bundle-load` test
proves the bundle require()s cleanly in a bare process with zero
`node_modules` reachable.

## License

MIT © 2026 Eldar Djafarov. See [`LICENSE`](./LICENSE). Provided "as is",
without warranty — including with respect to WhatsApp account safety.
