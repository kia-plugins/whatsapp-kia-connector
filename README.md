# whatsapp-kia-connector

An **unofficial**, self-contained WhatsApp connector for [alpha-cent / KIAgent](https://github.com/edjafarov/alpha-cent). It links a companion device through the [Baileys](https://github.com/WhiskeySockets/Baileys) library and ingests your chats — plus an offline chat-export importer — into your local KIAgent corpus.

It ships as a single bundled `dist/index.js` (Baileys + adm-zip + whatsapp-chat-parser are bundled in) and loads through the alpha-cent connector distribution pipeline.

## ⚠️ Ban risk (read this first)

This connector is **unofficial**. WhatsApp does not provide a public client API, so Baileys links your number as an unofficial companion device by reverse-engineering the WhatsApp Web protocol. **Using it may get your WhatsApp number temporarily or permanently banned.** There is no warranty (see `LICENSE`). Linking a device you can afford to lose, and keeping media/contact fetches gentle, reduces — but does not eliminate — the risk. Use at your own risk.

The offline **import** path (a WhatsApp chat export `.zip`/`.txt`) carries no ban risk — it never connects to WhatsApp.

## Host API

Requires alpha-cent **Host API `^1.1.0`** (the manifest declares `"hostApi": "^1.1.0"`). The connector talks to the host only through the documented `ConnectorHost` / `ConnectorSetupHost` surface (db, converter, safeStorage, dataDir, emitStreamEvent, pickFile, hostFor, restartAccount, removeAccount). It bundles **no** alpha-cent code; the SDK is consumed as types only.

## Install

The connector runs as a host-loaded module. There are two ways to get it into the app.

### Tier 1 — sideload (build it yourself)

```bash
git clone https://github.com/edjafarov/whatsapp-kia-connector
cd whatsapp-kia-connector
npm install
npm run build      # produces dist/index.js
```

Then copy the build artifacts into the app's connectors directory:

```bash
# macOS example — adjust the userData path for your platform / app name
CONN="$HOME/Library/Application Support/KIAgent/connectors/whatsapp"
mkdir -p "$CONN/dist"
cp manifest.json "$CONN/"
cp dist/index.js "$CONN/dist/"
```

Restart the app. A **WhatsApp** tile appears under *Add a source*.

### Tier 2 — install from the release tarball (no local toolchain)

The app downloads and verifies the tarball for you — you only paste a URL. The
URL and the integrity hash go in **two separate fields** (the hash is not a `#`
fragment on the URL).

1. In the app: **Add a source → Install connector…**
2. **npm name or tarball URL** — paste the [release](https://github.com/edjafarov/whatsapp-kia-connector/releases/tag/v1.0.0) asset URL:

   ```
   https://github.com/edjafarov/whatsapp-kia-connector/releases/download/v1.0.0/whatsapp-kia-connector-1.0.0.tgz
   ```
3. **integrity hash (optional, recommended)** — paste the published SRI into the second field to pin it:

   ```
   sha512-bBOBuTJ1rp3SWohKj98jhqNugNIeeffhNj0GXQBeAEmcb1LC+JuiEgLczXUUP3NV3pSZermj2wMgjdQmCRi7Hw==
   ```

   Verify it yourself against the asset the app will download (must print the
   string above verbatim):

   ```bash
   curl -sL https://github.com/edjafarov/whatsapp-kia-connector/releases/download/v1.0.0/whatsapp-kia-connector-1.0.0.tgz \
     | openssl dgst -sha512 -binary | { printf 'sha512-'; base64; }
   ```

   Omit the hash and the installer pins it on first install (trust-on-first-use).
4. **Review** → the consent dialog shows the manifest (no connector code runs yet) → **Install & trust**.

## Trust model

A connector module runs **unsandboxed in the app's main process** — it has the same capabilities as the app itself (filesystem, network, your linked device). The install pipeline verifies the tarball integrity hash (when supplied) and shows a consent dialog that previews the manifest before loading the entry, but it cannot constrain what the code does once loaded.

**Only install connectors from authors you trust.** Prefer Tier 1 (build the `dist/` yourself from source you have read) when you want maximum assurance. The entire source is in this repo and the production bundle is reproducible with `npm run build`.

## Build from source

```bash
npm install        # builds Baileys + better-sqlite3 (native) — first run takes a minute
npm run build      # esbuild → dist/index.js (~7 MB, self-contained CJS)
npm test           # typed harness + ported specs + standalone bundle-load guard
npm run pack       # build + npm pack → whatsapp-kia-connector-1.0.0.tgz
```

`better-sqlite3` is a **test-only** dependency (the in-memory harness); it is not bundled. The four optional native media deps Baileys can lazy-load (`sharp`, `jimp`, `link-preview-js`, `audio-decode`) are externalized — the buffer-download path used here does not need them, and the `bundle-load` test proves the bundle requires cleanly with zero `node_modules` reachable.

## Releasing a new version

A release is a single tarball published as a GitHub release asset, with its
integrity hash pinned in the [Tier 2](#tier-2--install-from-the-release-tarball-no-local-toolchain)
block above. The version string lives in **three places that must match**:
`package.json` (`version`), `manifest.json` (`version`), and the release tag /
tarball URL.

1. **Bump the version** in both `package.json` and `manifest.json` (e.g.
   `1.0.0` → `1.0.1`). `npm pack` names the tarball from `package.json`; the app
   records and displays `manifest.version`, so a mismatch shows the wrong
   version in the installed-connectors list.

2. **Build, test, pack** — produces `whatsapp-kia-connector-<version>.tgz`:

   ```bash
   npm install        # only if dependencies changed
   npm test           # tsc + ported specs + bundle-load guard must be green
   npm run pack       # build.mjs → dist/index.js, then npm pack → the .tgz
   ```

3. **Compute the integrity hash of the exact tarball you just packed.** The SRI
   changes on every pack (gzip embeds metadata), so always recompute it against
   the file you are about to upload — never reuse a previous version's hash:

   ```bash
   openssl dgst -sha512 -binary whatsapp-kia-connector-<version>.tgz \
     | { printf 'sha512-'; base64; }
   ```

4. **Publish the release** with that tarball as the asset:

   ```bash
   gh release create v<version> whatsapp-kia-connector-<version>.tgz \
     --title "v<version>" \
     --notes "Integrity: sha512-…   (⚠️ unofficial — Baileys companion device; ban risk)"
   ```

5. **Re-pin the Tier 2 block above** — update the download URL (the `v<version>`
   path segment + filename) and the integrity hash to the new release, then
   commit and push:

   ```bash
   git add README.md package.json manifest.json
   git commit -m "release: v<version>"
   git push
   ```

Updating an already-installed connector needs **no uninstall**: a user re-runs
**Add a source → Install connector…** with the new URL, and the installer
overwrites the connector directory in place, evicts the stale module from the
require cache, and loads the new bundle — even when sources for it already
exist. (Tier 1 sideloaders just rebuild and re-copy `dist/index.js`.)

## License

MIT © 2026 Eldar Djafarov. See [`LICENSE`](./LICENSE). Provided "as is", without warranty — including with respect to WhatsApp account safety.
